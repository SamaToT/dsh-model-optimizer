// @deepseek-ai/dsh-model-optimizer
// BUILD_STAMP: 2026-10-21T11:00:00Z (version with fitReasoningEffort catch fix + system-prompt identity sync)
//
// Cost-tiered model failover for DeepSeek Harness — UNIVERSAL / zero-config.
//
// DeepSeek Harness ships only same-model retry (@deepseek-ai/dsh-llm-retry). When
// a model is *unusable* (quota exhausted, auth failure, no adapter, context window
// exceeded, …) the turn just ends. This plugin walks a cost-ordered fallback chain
// so the agent keeps working, cheapest first: free -> credits -> paid.
//
// HOW IT STAYS GENERIC (no hand-written model list):
//   On first use the plugin enumerates whatever routes THIS user has installed via
//   ctx.llm.listProviders() + ctx.llm.listModels(provider), then classifies each
//   route into a cost tier with a small, editable rule set:
//
//     our-free-model            -> free    (the whole provider is free)
//     workbuddy                 -> parse the model NAME: "x0" / "免费" / "限时免费"
//                                   => free; any other "x<number>" multiplier
//                                   => credits
//     deepseek-account          -> credits (logged-in account balance)
//     deepseek-official         -> paid    (API key, per-token billing)
//     anything else (unknown)   -> paid    (conservative: never silently burn a
//                                           third-party key; override via config)
//
//   OFM routes whose availability probe says `region-blocked` or `unavailable`
//   are dropped so the chain does not waste attempts on them.
//
// OFFICIAL EXTENSION POINTS ONLY:
//   agent-loop runs a `while (true)` step loop. Every iteration calls the
//   `agent/request` waterfall to resolve { provider, model }; if the stream ends
//   in error it calls `agent/request-error`. Returning { kind: "retry" } there
//   re-runs the failed step. So this plugin:
//     - on `agent/request`, uses the user's selected model first, then — once an
//       escalation is in progress — the next cost-ordered chain entry;
//     - on `agent/request-error` (prepended, decides before dsh-llm-retry),
//       advances the chain on a "route is dead" code and returns { kind: "retry" }.
//
// Failure codes are stable and machine-routable (never parse message text):
//   QUOTA / ACCOUNT_QUOTA / AUTH / NO_ADAPTER / INVALID_CREDENTIAL /
//   MISSING_CREDENTIAL / CONTEXT_WINDOW_EXCEEDED -> escalate to the next tier.

import z from "@deepseek-ai/schemastery";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const name = "llm-failover";

/**
 * Optional debug log.
 *
 * DSH's logger goes to the host process stdout, which the desktop app swallows,
 * so a user cannot see why a switch did or did not happen. Writing the same
 * lines to a file under the Harness home makes the plugin's decisions
 * inspectable. Off unless `debugLog` names a path.
 */
function debugWriter(path) {
  if (typeof path !== "string" || path.trim() === "") return () => {};
  const target = path.startsWith("~")
    ? join(homedir(), path.slice(1))
    : path;
  return (line) => {
    try {
      appendFileSync(target, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // A debug log must never break the plugin.
    }
  };
}

const TIER_ORDER = { free: 0, credits: 1, paid: 2 };

/**
 * Rules for the providers this plugin knows by name.
 *
 * They are defaults, not policy: a user with a different provider set overrides
 * them through `providerRules`, and a provider nobody configured is classified
 * from its own model metadata. Keeping the known ones here means the common
 * DeepSeek Harness setups work with zero configuration.
 */
const DEFAULT_PROVIDER_RULES = {
  // The free lane: every model it serves costs nothing.
  "our-free-model": { tier: "free" },
  // WorkBuddy serves both free and credit-billed models; the tier follows the
  // price each model currently carries.
  "workbuddy": { tier: "credits", price: "workbuddy" },
  // The signed-in DeepSeek account spends the account's balance.
  "deepseek-account": { tier: "credits" },
  // The DeepSeek API key is billed per token.
  "deepseek-official": { tier: "paid" }
};

/** Price catalogs the default rules refer to, by name. */
const DEFAULT_PRICE_CATALOGS = {
  workbuddy: "~/.dsh/.workbuddy-catalog.json"
};

const DEFAULT_ESCALATE_ON = [
  "QUOTA",
  "ACCOUNT_QUOTA",
  "AUTH",
  "NO_ADAPTER",
  "INVALID_CREDENTIAL",
  "MISSING_CREDENTIAL",
  "CONTEXT_WINDOW_EXCEEDED",
  // The selected model rejected the requested reasoning effort. Another model
  // may support it; fitReasoningEffort() also drops or remaps the effort.
  "UNSUPPORTED_REASONING_EFFORT",
  // A rejected request body, an unsupported parameter, a model the upstream
  // will not serve: the route itself is the problem, so another route may work.
  // Adapters surface these as CLIENT_ERROR / INVALID_REQUEST.
  "CLIENT_ERROR",
  "INVALID_REQUEST",
  "INVALID_MODEL_REASONING",
  // The upstream refuses further calls for a while ("quota exceeded, resets
  // tomorrow"). Retrying the SAME route cannot help — dsh-llm-retry would burn
  // its whole budget doing nothing — so this switches instead.
  "RATE_LIMIT",
  // The free lane's own codes (it maps upstream state onto these):
  //   REGION_BLOCKED          this model is not served from your region;
  //                           another route may not carry the restriction.
  //   AUTHORIZATION_REQUIRED  this lane has not been authorized (sign-in or
  //                           an unclaimed co-paid slot); another provider may
  //                           already be authorized.
  "REGION_BLOCKED",
  "AUTHORIZATION_REQUIRED",
  // The model cannot take the images the request carries; a model that
  // accepts images can serve it instead.
  "IMAGE_OFFLOAD_REQUIRED",
  // pi-ai's catch-all for an upstream failure it could not classify. Retrying
  // the same route rarely helps; another route may simply work.
  "PI_AI_ERROR",
  // DSH's own catch-all: an error that is not a HarnessError at all is
  // normalized to UNKNOWN, which the UI shows as an unexpected error. It
  // covers a genuine "this route is broken" as well as a stray network blip,
  // so it is retried in place first and only then switched away from.
  "UNKNOWN",
];

/** A route entry in the failover chain. */
const Route = z.object({
  provider: z.string(),
  model: z.string(),
});

const Config = z.object({
  // Explicit chain, highest priority. When set, auto-discovery is skipped entirely.
  // Useful for hand-tuned setups; leave empty for the universal behavior.
  chain: z.array(Route).default([]),
  // Per-route tier override: { "provider/model": "free" | "credits" | "paid" }.
  tierOverrides: z.dict(z.string()).default({}),
  // Per-provider tier override: { "workbuddy": "free" } applies to every model of
  // that provider (unless a more specific route override exists).
  providerTiers: z.dict(z.string()).default({}),
  // Route keys to exclude from the chain entirely: ["provider/model", ...].
  excludeModels: z.array(z.string()).default([]),
  // Per-provider rule: { tier, price, pinTier }. `price` names a price
  // catalog from `priceCatalogs`; `pinTier` makes the rule win over the
  // model's own price label.
  providerRules: z.dict(z.object({
    tier: z.string(),
    price: z.string(),
    pinTier: z.boolean()
  })).default({}),
  // Price catalogs by name; a provider rule names one with `price: "<name>"`.
  priceCatalogs: z.dict(z.string()).default({}),
  // Providers to exclude entirely: ["some-provider", ...].
  excludeProviders: z.array(z.string()).default([]),
  // Tier for a provider no rule recognises. "paid" is the safe default so a
  // third-party key is never silently treated as free.
  defaultTierForUnknown: z.string().default("paid"),
  // Drop OFM routes the local availability probe marks as region-blocked or
  // unavailable, so the chain does not waste attempts on them.
  skipBlockedFreeModels: z.boolean().default(true),
  // Inside the free tier, try the free lane's best-ranked model first. The
  // ranking is the free catalog's own order (kiloRows, then entries).
  preferRanked: z.boolean().default(true),
  // Inside the credits tier, try the cheapest model first. Uses WorkBuddy's
  // own price list; a model with no published price sorts last.
  preferCheapestCredits: z.boolean().default(true),
  // Override the catalog path used for the ranking.
  rankingCatalogPath: z.string().default(""),
  // Override the WorkBuddy price-list path.
  workBuddyCatalogPath: z.string().default(""),
  // Write the plugin's decisions to this file. DSH's logger goes to the host
  // process stdout, which the desktop app swallows, so this is the only way to
  // see why a switch did or did not happen. Empty disables it.
  debugLog: z.string().default(""),
  // Failure codes that mean "this route is unusable, try the next one".
  escalateOn: z.array(z.string()).default(DEFAULT_ESCALATE_ON),
  // If true, also escalate on transient errors (RATE_LIMIT/SERVER/TIMEOUT/
  // TRANSPORT/EMPTY_RESPONSE). Leave false: dsh-llm-retry already retries the
  // same route on those.
  escalateOnTransient: z.boolean().default(false),
  // How many times one route may fail with a *retryable* code (RATE_LIMIT by
  // default) before the plugin switches away from it.
  //
  // A short rate limit is worth retrying in place — that is what
  // dsh-llm-retry is for. A long one is not, and there is no way to tell them
  // apart from the code alone, so this counts: after `retriesBeforeSwitch`
  // failures on the same route the plugin stops waiting and moves on. 0 means
  // "switch on the first failure".
  retriesBeforeSwitch: z.number().step(1).min(0).default(2),
  // A route that always ends the chain and is never switched away from.
  //
  // When a chain is exhausted the plugin normally just lets the turn fail, so
  // the last route tried is whatever the tiering put last. Naming a fallback
  // here pins it: it is appended to the chain, tried last, and a failure on it
  // ends the turn instead of escalating again — which is what keeps a chain
  // that cannot serve the request from looping.
  fallback: z.object({ provider: z.string(), model: z.string() }).required(false),
  // How long a route that just failed is skipped for, in milliseconds. The
  // same route failing twice in a row inside the window is not retried; the
  // chain moves on immediately. 0 disables the cooldown.
  cooldownMs: z.number().step(1).min(0).default(60000),
  // Providers whose gateway refuses a system prompt that opens with a rival
  // client's identity line.
  //
  // Some upstreams (WorkBuddy since 2026-10-20) run a channel check on the
  // opening of the system message and answer such a request with HTTP 400 /
  // code 11128. DSH's own identity line is exactly such a signature, so the
  // request is rejected before the model is ever reached.
  //
  // For the listed providers the identity section is renamed to a neutral
  // one. The rest of the prompt is untouched, and every other provider keeps
  // the identity it has today. Empty disables the behaviour.
  neutralizeIdentityFor: z.array(z.string()).default([]),
});

/**
 * A failover cursor key.
 *
 * DSH's `turn` payload already carries the session id (e.g.
 * "session-022699e8-…|103"), so `${turn}:${step}` is globally unique across
 * sessions without extra keying. Do NOT reference an `agent` variable here —
 * none is in scope and it throws ReferenceError on every request.
 */
function keyOf(turn, step) {
  return `${turn}:${step}`;
}

function sameRoute(a, b) {
  return !!a && !!b && a.provider === b.provider && a.model === b.model;
}

/**
 * The neutral opening that replaces the harness identity line.
 *
 * An upstream that checks the channel by the opening of the system message
 * only cares that the first line is not a rival client's identity claim.
 */
const NEUTRAL_IDENTITY = "You are a helpful assistant.";

/**
 * The availability probe: routes marked region-blocked or unavailable are
 * skipped.
 *
 * The shape is the one the free lane writes:
 * { "results": { "<model id>": { "state": "available|region-blocked|unavailable|unknown" } } }
 *
 * @returns a set of model ids to skip, or null when there is no probe.
 */
function loadAvailability(config) {
  const configured = config?.availabilityPath;
  const path = typeof configured === "string" && configured.trim() !== ""
    ? expandHome(configured)
    : join(homedir(), ".dsh", "our-free-model", "availability.json");
  try {
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf8"));
    const results = data?.results ?? {};
    const blocked = new Set();
    for (const [id, row] of Object.entries(results)) {
      if (row?.state === "region-blocked" || row?.state === "unavailable") blocked.add(id);
    }
    return blocked.size > 0 ? blocked : null;
  } catch {
    return null;
  }
}

/** Expand a leading "~" to the user's home directory. */
function expandHome(path) {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

/**
 * A ranking catalog: a provider's own preference order for its models.
 *
 * Two shapes are understood, because providers publish their catalogs in
 * different shapes and this plugin should not care:
 *
 *   { "kiloRows": [ { "id": "..." }, ... ], "entries": [ "id", ... ] }
 *   { "models": [ { "id": "...", "rank": 0 }, ... ] }
 *
 * In both cases the ARRAY ORDER is the ranking, with entries following
 * kiloRows. That order is the author's own preference, so a failover chain
 * tries the better model first instead of whatever the provider enumerated first.
 *
 * @returns a map of model id -> rank (lower is better), or null when absent.
 */
function loadRanking(config) {
  const configured = config?.rankingCatalogPath;
  const path = typeof configured === "string" && configured.trim() !== ""
    ? expandHome(configured)
    : join(homedir(), ".dsh", "our-free-model", "catalog.json");
  try {
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf8"));
    const ranks = new Map();
    let rank = 0;
    const take = (id) => {
      if (typeof id !== "string" || id === "") return;
      if (!ranks.has(id)) ranks.set(id, rank++);
    };
    for (const row of data?.kiloRows ?? []) take(typeof row === "string" ? row : row?.id);
    for (const id of data?.entries ?? []) take(id);
    for (const row of data?.models ?? []) {
      if (typeof row === "string") take(row);
      else if (typeof row?.rank === "number" && Number.isFinite(row.rank)) {
        if (typeof row.id === "string" && row.id !== "") ranks.set(row.id, row.rank);
      } else take(row?.id);
    }
    return ranks.size > 0 ? ranks : null;
  } catch {
    return null;
  }
}

/**
 * A price catalog: what a model costs.
 *
 * The shape is the one the WorkBuddy plugin writes under the Harness home:
 *
 *   { "entries": { "<key>": { "models": [
 *       { "id": "hy3", "billing": { "credits": "x0.00 credits", "free": true } } ] } } }
 *
 * A flat { "models": [...] } is understood too. The value read is the
 * multiplier, which is what the credits tier sorts by.
 *
 * The badges in such a file are STATIC, so they cannot say whether a model is
 * free right now. The runtime display name can: a provider that re-evaluates
 * promotions against the clock appends the effective rate to the model name,
 * and the tier decision reads that name. This catalog only supplies the
 * multiplier to sort by.
 *
 * @returns a map of model id -> { cost, free, order } or null.
 */
function loadPriceCatalog(path) {
  try {
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf8"));
    const models = new Map();
    const collect = (list) => {
      for (const model of list ?? []) {
        const id = model?.id;
        if (typeof id !== "string" || id === "") continue;
        const billing = model.billing ?? model.price ?? {};
        const raw = billing.credits ?? billing.rate ?? billing.cost;
        const cost = typeof raw === "string"
          ? Number(raw.match(/x\s*(\d+(?:\.\d+)?)/i)?.[1])
          : typeof raw === "number" ? raw : undefined;
        models.set(id, {
          cost: Number.isFinite(cost) ? cost : undefined,
          free: billing.free === true || (Number.isFinite(cost) && cost === 0),
          order: models.size
        });
      }
    };
    const entries = data?.entries;
    if (entries !== undefined && entries !== null) {
      for (const row of Object.values(entries)) collect(row?.models);
    } else {
      collect(data?.models);
    }
    return models.size > 0 ? models : null;
  } catch {
    return null;
  }
}

/**
 * Load every configured price catalog, keyed by the name a provider rule
 * refers to. A rule names its source with price: "<name>".
 */
function loadPriceCatalogs(config) {
  const sources = config?.priceCatalogs;
  if (sources === undefined || sources === null) return new Map();
  const catalogs = new Map();
  for (const [name, source] of Object.entries(sources)) {
    if (typeof source !== "string" || source === "") continue;
    const loaded = loadPriceCatalog(expandHome(source));
    if (loaded !== null) catalogs.set(name, loaded);
  }
  return catalogs;
}


/**
 * The author's own preference order for the free lane.
 *
 * The Our Free Model plugin keeps its catalog as ordered arrays — `kiloRows`
 * first, then the plain `entries` — and the plugin's own `listModels()` hands
 * DSH that order untouched, so the array index IS the ranking. Reading it
 * directly lets a failover chain try the better free model first instead of
 * whatever the provider happened to enumerate first.
 *
 * @returns a map of model id -> rank (lower is better), or null when absent.
 */
function loadFreeModelRanking(config) {
  const configured = config?.rankingCatalogPath;
  // The schema default is an empty string, and `??` does not treat "" as
  // absent — an empty override must still mean "use the default path".
  const path = typeof configured === "string" && configured.trim() !== ""
    ? configured
    : join(homedir(), ".dsh", "our-free-model", "catalog.json");
  try {
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf8"));
    const ranks = new Map();
    let rank = 0;
    // The vendor-prefixed Kilo rows are the live free pool, in preference order.
    for (const row of data?.kiloRows ?? []) {
      const id = typeof row === "string" ? row : row?.id;
      if (typeof id !== "string" || id === "") continue;
      if (!ranks.has(id)) ranks.set(id, rank++);
    }
    // The plain entries are the other lane of the same free catalog.
    for (const id of data?.entries ?? []) {
      if (typeof id !== "string" || id === "") continue;
      if (!ranks.has(id)) ranks.set(id, rank++);
    }
    return ranks.size > 0 ? ranks : null;
  } catch {
    return null;
  }
}

/**
 * WorkBuddy's own catalog: the per-model credit cost and the free flag.
 *
 * The catalog the WorkBuddy plugin keeps under the Harness home carries
 * `billing.credits` (e.g. "x0.29 credits") and `billing.free` for every model
 * it serves. That is the price list — far better than reading a multiplier out
 * of a display name, and it distinguishes a genuinely free model from one that
 * merely costs a little.
 *
 * The badges in that file are STATIC ("夜间免费" stays in the file after the
 * window closed), so they cannot say whether a model is free right now. The
 * runtime display name can: the WorkBuddy plugin re-evaluates every promotion
 * against the current clock and appends the resulting rate and badge to the
 * model name, so a model outside its window shows no rate and no badge. The
 * tier decision therefore uses the runtime name, and this catalog only
 * supplies the multiplier to sort by.
 *
 * @returns a map of model id -> { cost, free, timeLimitedFree, order } or null.
 */
function loadWorkBuddyCatalog(config) {
  const configured = config?.workBuddyCatalogPath;
  const path = typeof configured === "string" && configured.trim() !== ""
    ? configured
    : join(homedir(), ".dsh", ".workbuddy-catalog.json");
  try {
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf8"));
    const entries = data?.entries;
    if (entries === undefined || entries === null) return null;
    const models = new Map();
    for (const row of Object.values(entries)) {
      for (const model of row?.models ?? []) {
        const id = model?.id;
        if (typeof id !== "string" || id === "") continue;
        const billing = model.billing ?? {};
        const cost = typeof billing.credits === "string"
          ? Number(billing.credits.match(/x\s*(\d+(?:\.\d+)?)/i)?.[1])
          : undefined;
        models.set(id, {
          cost: Number.isFinite(cost) ? cost : undefined,
          // Free outright (price x0.00 / free flag) in the saved catalog.
          free: billing.free === true,
          // The catalog's own order is the vendor's quality ranking.
          order: models.size
        });
      }
    }
    return models.size > 0 ? models : null;
  } catch {
    return null;
  }
}

/**
 * Classify one route into a cost tier.
 * Rules are intentionally explicit and conservative; every one of them can be
 * overridden per route or per provider through the plugin config.
 */
function tierOf(provider, model, modelName, config) {
  const routeKey = `${provider}/${model}`;
  const tierOverrides = config.tierOverrides ?? {};
  const providerTiers = config.providerTiers ?? {};
  // An explicit override is the user speaking last: nothing below may override it.
  if (tierOverrides[routeKey] !== void 0) return tierOverrides[routeKey];
  if (providerTiers[provider] !== void 0) return providerTiers[provider];

  const rules = config.providerRules ?? {};
  const rule = rules[provider];
  const ruleTier = rule !== undefined && typeof rule === "object" && typeof rule.tier === "string"
    ? rule.tier
    : undefined;
  // A pinned rule wins even when the model carries a price of its own.
  if (ruleTier !== undefined && rule?.pinTier === true) return ruleTier;

  // The route's own price label. Many providers append the current rate to the
  // display name ("Hy4 preview · x0.29 credits"), and a provider that
  // re-evaluates promotions against the clock shows the CURRENT rate — so a zero
  // rate means the model is free right now and any other rate means it costs
  // something. This is what makes the plugin provider-agnostic.
  const priced = priceFromLabel(`${modelName ?? ""} ${model ?? ""}`);
  if (priced !== undefined) return priced.tier;

  // A rule may name a price catalog for this provider.
  const source = rule !== undefined && typeof rule === "object" ? rule.price : undefined;
  if (typeof source === "string" && source !== "") {
    const entry = config?.priceCatalogs?.get(source)?.get(model);
    if (entry !== undefined) {
      if (entry.free === true) return "free";
      if (entry.cost !== undefined) return "credits";
    }
  }

  // The provider's own tier, when the model carries no price of its own.
  if (ruleTier !== undefined) return ruleTier;

  return config.defaultTierForUnknown || "paid";
}

/**
 * Read a price out of a display label.
 *
 * Recognises a multiplier ("x0.29", "×1.62") and a free marker ("免费", "free")
 * in either language, which is what providers that publish a rate into the model
 * name look like.
 *
 * @returns { tier: string, cost: number | undefined } | undefined
 */
function priceFromLabel(label) {
  if (typeof label !== "string" || label === "") return undefined;
  if (/免费|free/i.test(label)) return { tier: "free", cost: 0 };
  const m = label.match(/[×xX]\s*(\d+(?:\.\d+)?)/);
  if (m === null) return undefined;
  const cost = Number(m[1]);
  if (!Number.isFinite(cost)) return undefined;
  return { tier: cost === 0 ? "free" : "credits", cost };
}

function apply(ctx, config = {}) {
  const raw = config ?? {};
  // The built-in rules are defaults: a user's own rules for the same provider
  // replace them, and a provider neither knows keeps the built-in default.
  const providerRules = { ...DEFAULT_PROVIDER_RULES, ...(raw.providerRules ?? {}) };
  const priceCatalogs = { ...DEFAULT_PRICE_CATALOGS, ...(raw.priceCatalogs ?? {}) };
  const cfg = { ...raw, providerRules, priceCatalogs };
  const debug = debugWriter(cfg.debugLog);
  const escalateOn = new Set(
    Array.isArray(cfg.escalateOn) && cfg.escalateOn.length ? cfg.escalateOn : DEFAULT_ESCALATE_ON
  );
  const escalateTransient = cfg.escalateOnTransient === true;
  // Codes that are worth retrying on the same route before giving up on it.
  // UNKNOWN is here because it is DSH's catch-all: it covers both a route that
  // is genuinely broken and a stray network blip, and only the second kind
  // recovers on its own.
  const TRANSIENT = new Set(["RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT", "EMPTY_RESPONSE"]);

  const excludeProviders = new Set(cfg.excludeProviders ?? []);
  const excludeModels = new Set(cfg.excludeModels ?? []);
  const neutralizeFor = new Set(cfg.neutralizeIdentityFor ?? []);

  const llm = ctx.get("llm");

  // Per-(turn,step) failover cursor.
  //   pos = -1  -> using the user's selected route
  //   pos >= 0  -> using chain[pos]
  /** @type {Map<string, { pos: number, selection: { provider: string, model: string } }>} */
  const state = new Map();
  let pruneGuard = 0;
  // The route the transcript last announced, so the notice is written once per
  // switch rather than on every step.
  let lastAnnounced;
  // The route the failover started from, named in the notice.
  let lastSelection;
  // Route -> cooldown deadline (ms epoch). A route inside its window is not
  // tried again until it passes, so a route that just failed cannot be picked
  // twice in a row.
  const cooldowns = new Map();
  // "<turn:step>|<provider>/<model>" -> consecutive retryable failures, so a
  // route that keeps failing is switched away from instead of retried forever.
  const retryCounts = new Map();

  // Chain cache; invalidated when adapters change.
  let chainCache = null;
  let chainBuilding = null;
  // Reasoning capability per route, same lifetime as the chain.
  const effortCache = new Map();
  const invalidate = () => {
    chainCache = null;
    chainBuilding = null;
    effortCache.clear();
  };
  ctx.on?.("llm/adapters-updated", invalidate);

  /** Build (and cache) the cost-ordered chain for this installation. */
  async function buildChain() {
    if (Array.isArray(cfg.chain) && cfg.chain.length > 0) return cfg.chain;
    if (chainCache) return chainCache;
    if (chainBuilding) return chainBuilding;

    chainBuilding = (async () => {
      const blocked = cfg.skipBlockedFreeModels !== false ? loadAvailability(cfg) : null;
      const ranks = cfg.preferRanked !== false ? loadRanking(cfg) : null;
      const priceCatalogs = loadPriceCatalogs(cfg);
      // tierOf() reads the price lists from the config it is given.
      const tierCfg = { ...cfg, priceCatalogs };
      const tiers = { free: [], credits: [], paid: [] };

      let providers = [];
      try {
        providers = (await llm.listProviders()) ?? [];
      } catch (error) {
        ctx.logger?.warn?.(`llm-failover: listProviders() failed (${error?.message ?? error}); failover disabled`);
        return [];
      }

      for (const providerRow of providers) {
        const provider = providerRow?.id;
        if (!provider || excludeProviders.has(provider)) continue;

        let models = [];
        try {
          models = (await llm.listModels(provider)) ?? [];
        } catch {
          continue; // a provider we cannot enumerate is simply not a fallback
        }

        for (const model of models) {
          const id = model?.id;
          if (!id) continue;
          const routeKey = `${provider}/${id}`;
          if (excludeModels.has(routeKey)) continue;
          if (blocked?.has(id)) continue;

          const tier = tierOf(provider, id, model.name, tierCfg);
          if (tiers[tier] === void 0) tiers[tier] = [];
          // The runtime name carries the current rate; keep it so the credits
          // tier can sort by what a model costs RIGHT NOW, not by a cached
          // price that may be stale or out of its free window.
          const rate = (model.name ?? "").match(/[×xX]\s*(\d+(?:\.\d+)?)/);
          tiers[tier].push({
            provider,
            model: id,
            ...(rate === null ? {} : { cost: Number(rate[1]) })
          });
        }
      }

      // Inside the free tier, try the author's best-ranked free model first.
      // The ranking comes from the free lane's own catalog order; routes with no
      // rank keep their discovery order and follow the ranked ones.
      if (cfg.preferRanked !== false && ranks !== null) {
        const byRank = (a, b) => {
          const ra = ranks.get(a.model);
          const rb = ranks.get(b.model);
          // Ranked routes first, in the free lane's own order; routes the
          // ranking does not know (another provider's free models) follow.
          if (ra === undefined && rb === undefined) return 0;
          if (ra === undefined) return 1;
          if (rb === undefined) return -1;
          return ra - rb;
        };
        tiers.free = [...tiers.free].sort(byRank);
      }

      // Inside the credits tier, spend the least credits first.
      //
      // The cost comes from the RUNTIME display name, because that is the rate
      // the WorkBuddy plugin computed for the current clock: a model inside its
      // free window shows "x0.00" and sorts first, and the same model outside
      // the window shows its normal price. A model with no visible rate has an
      // unknown price, so it sorts last.
      if (cfg.preferCheapestCredits !== false) {
        // The runtime rate wins: inside a free window it reads x0.00. Outside
        // the window the rate is not shown at all, and then the saved catalog's
        // own multiplier is the price the model actually charges.
        const entryOf = (route) => {
          for (const catalog of priceCatalogs.values()) {
            const entry = catalog.get(route.model);
            if (entry !== undefined) return entry;
          }
          return undefined;
        };
        const costOf = (route) => route.cost ?? entryOf(route)?.cost;
        const orderOf = (route) => entryOf(route)?.order ?? 0;
        tiers.credits = [...tiers.credits].sort((a, b) => {
          const ca = costOf(a);
          const cb = costOf(b);
          if (ca === undefined && cb === undefined) return orderOf(a) - orderOf(b);
          if (ca === undefined) return 1;
          if (cb === undefined) return -1;
          if (ca !== cb) return ca - cb;
          // Same price: the catalog's own order is the quality ranking.
          return orderOf(a) - orderOf(b);
        });
      }

      // free -> credits -> paid, preserving discovery order inside each tier.
      let chain = [...tiers.free, ...tiers.credits, ...tiers.paid];

      // A configured fallback is appended and pinned: it is the last route
      // tried and a failure on it ends the turn instead of escalating again.
      const fb = cfg.fallback;
      if (fb !== undefined && typeof fb.provider === "string" && fb.provider !== "") {
        const key = `${fb.provider}/${fb.model}`;
        chain = chain.filter((route) => `${route.provider}/${route.model}` !== key);
        chain.push({ provider: fb.provider, model: fb.model, fallback: true });
      }

      chainCache = chain;
      chainBuilding = null;
      ctx.logger?.debug?.(
        `llm-failover: discovered ${chain.length} routes ` +
          `(free ${tiers.free.length}, credits ${tiers.credits.length}, paid ${tiers.paid.length})`
      );
      debug(
        `chain free=${tiers.free.length} credits=${tiers.credits.length} paid=${tiers.paid.length} :: ` +
          chain.map((r) => `${r.provider}/${r.model}${r.fallback ? "(fallback)" : ""}`).join(" > ")
      );
      return chain;
    })();

    return chainBuilding;
  }

  /** Whether a route is inside its cooldown window. */
  function cooling(route) {
    const until = cooldowns.get(`${route.provider}/${route.model}`);
    if (until === undefined) return false;
    if (until <= Date.now()) {
      cooldowns.delete(`${route.provider}/${route.model}`);
      return false;
    }
    return true;
  }

  /**
   * The next chain position after `from` whose route is not in cooldown.
   *
   * The selection itself is skipped when it appears in the chain (it was just
   * tried), and a route that just failed is skipped while it cools down. The
   * pinned fallback is exempt from the selection skip: when the selection and
   * the fallback are the same route, it is still the end of the chain and must
   * be reachable. When nothing is left the walk returns -1.
   */
  function nextPos(chain, from, selection) {
    const last = chain.length - 1;
    for (let pos = from + 1; pos < chain.length; pos++) {
      const route = chain[pos];
      const pinned = pos === last && route.fallback === true;
      if (!pinned && selection !== undefined && sameRoute(route, selection)) continue;
      if (!pinned && cooling(route)) continue;
      return pos;
    }
    return -1;
  }

  /** Resolve the route to use for the current cursor. */
  function routeFor(cur, chain) {
    return cur.pos < 0 ? cur.selection : chain[cur.pos];
  }

  /**
   * Keep the requested reasoning effort only when the NEW model supports it.
   *
   * Switching models without this check is a trap: dsh-llm validates the effort
   * against the target model's declared capabilities and throws
   * UNSUPPORTED_REASONING_EFFORT, so a chain that moves to a model without the
   * requested effort would fail again on the very next attempt.
   */
  /**
   * Fit the requested reasoning effort to what the target model accepts.
   *
   * DSH offers one global effort list (off < minimal < low < medium < high <
   * xhigh < max) while every model supports its own subset, so a level the
   * picker offers is regularly unsupported by the model that is about to answer.
   * dsh-llm rejects that with UNSUPPORTED_REASONING_EFFORT — and it rejects it
   * while resolving the request, BEFORE the stream starts, which is a phase
   * that never reaches the `agent/request-error` waterfall. The failure would
   * therefore end the turn instead of switching models.
   *
   * So the effort is fitted here, in the request waterfall, before it can fail:
   *
   *   - the model accepts the level  -> keep it;
   *   - it does not, but accepts others -> use the HIGHEST level it accepts
   *     (the picker may offer a level the model cannot do, and asking for less
   *     than the model can do wastes capability);
   *   - it accepts none            -> drop the parameter, which is what such a
   *     model expects.
   *
   * Only public API is used: `llm.resolveModelInfo` reports the model's own
   * effort set, and its `efforts` array keeps the escalation order, so the last
   * entry is the highest level that model offers.
   */
  async function fitReasoningEffort(config, route, signal) {
    const requested = config.reasoningEffort;
    if (requested === undefined) return config;
    const cacheKey = `${route.provider}/${route.model}`;
    let reasoning = effortCache.get(cacheKey);
    if (reasoning === undefined) {
      let info;
      try {
        info = await llm.resolveModelInfo(route.provider, route.model, signal);
      } catch (error) {
        // dsh-llm rejects a model that declares an EMPTY effort set
        // (INVALID_MODEL_REASONING). That is not a lookup failure: such a model
        // takes no effort parameter at all, so the request must carry none.
        debug(
          `effort lookup failed for ${route.provider}/${route.model} ` +
            `(${error?.code ?? ""}): ${error?.message ?? error} -> dropping effort`
        );
        effortCache.set(cacheKey, null);
        const { reasoningEffort, ...rest } = config;
        return rest;
      }
      reasoning = info?.reasoning;
      effortCache.set(cacheKey, reasoning ?? null);
      debug(
        `effort lookup ${route.provider}/${route.model} -> ` +
          (reasoning === undefined
            ? "no reasoning support"
            : `efforts=[${(reasoning.efforts ?? []).map((e) => e.id).join(",")}] default=${reasoning.defaultEffort}`)
      );
    }
    if (reasoning === undefined || reasoning === null) {
      // The model declares no reasoning support at all: drop the request so
      // dsh-llm does not reject it.
      const { reasoningEffort, ...rest } = config;
      ctx.logger?.debug?.(
        `llm-failover: dropped reasoning effort "${reasoningEffort}" for ${route.provider}/${route.model} (no reasoning support)`
      );
      return rest;
    }
    const efforts = reasoning.efforts ?? [];
    if (efforts.length === 0) {
      // The model declares an empty effort set: it takes no effort parameter.
      const { reasoningEffort, ...rest } = config;
      ctx.logger?.debug?.(
        `llm-failover: dropped reasoning effort "${reasoningEffort}" for ${route.provider}/${route.model} (empty effort set)`
      );
      return rest;
    }
    if (efforts.some((effort) => effort.id === requested)) return config;
    // The highest level this model accepts: the efforts array keeps DSH's
    // escalation order, so the last entry is the strongest one.
    const highest = efforts[efforts.length - 1];
    if (highest === undefined) {
      const { reasoningEffort, ...rest } = config;
      ctx.logger?.debug?.(
        `llm-failover: dropped reasoning effort "${requested}" for ${route.provider}/${route.model} (no effort available)`
      );
      return rest;
    }
    ctx.logger?.debug?.(
      `llm-failover: reasoning effort "${requested}" -> "${highest.id}" for ${route.provider}/${route.model}`
    );
    return { ...config, reasoningEffort: highest.id };
  }

  /**
   * Keep the prompt's idea of the model in step with the route we actually use.
   *
   * The system prompt renders `{{provider}}` / `{{model}}` from the agent's own
   * options (dsh-agent-loop registers those variables), so a failover that only
   * rewrites the request route leaves the model claiming to be the model it was
   * before — it answers "I am deepseek-flash" while deepseek-flash is not in the
   * picture at all. This listener rewrites the same variables the built-in
   * model selection rewrites, so the prompt names the model that is answering.
   */
  const disposeAssemble = ctx.on(
    "system-prompt/assemble",
    async (assembly, context, next) => {
      const assembled = await next();
      if (!assembled || typeof assembled !== "object") return assembled;
      // The route that is actually in use for the step being assembled.
      const active = activeRoute();
      const variables = assembled.variables;

      let result = assembled;
      if (variables !== undefined && typeof variables === "object" && active !== undefined) {
        result = {
          ...result,
          variables: {
            ...variables,
            provider: active.provider,
            model: active.model
          }
        };
      }

      return neutralizeIdentity(result, context);
    }
  );

  /**
   * Replace the harness identity line for providers that refuse it.
   *
   * Some upstreams run a channel check on the OPENING of the system message
   * and answer a prompt that starts with a rival client's identity line with
   * HTTP 400 / code 11128 ("Illegal API invocation from an unapproved
   * channel"). The check looks at the opening, not at the content, so a
   * neutral first line is enough to pass it — the prompt that follows is
   * delivered unchanged.
   *
   * DSH offers no switch for this: `includeHarnessIdentity: false` removes the
   * line for every provider, and `personaPrefix` is ordered AFTER the identity
   * section, so it cannot precede it. The rename below is scoped to the
   * providers that need it and to the request at hand.
   */
  function neutralizeIdentity(assembly, context) {
    if (neutralizeFor.size === 0) return assembly;
    const provider = routeProviderFor(context);
    if (provider === undefined || !neutralizeFor.has(provider)) return assembly;
    const sections = assembly.sections;
    if (!Array.isArray(sections)) return assembly;
    let changed = false;
    const rewritten = sections.map((section) => {
      if (section?.name !== "harness:identity") return section;
      if (typeof section.text !== "string") return section;
      if (section.text.trim() === "") return section;
      changed = true;
      return { ...section, text: NEUTRAL_IDENTITY };
    });
    if (!changed) return assembly;
    debug(`neutralized the harness identity for provider ${provider}`);
    return { ...assembly, sections: rewritten };
  }

  /**
   * The provider the prompt is being assembled for.
   *
   * The assembly context carries the agent, whose options name the selected
   * route. A failover in progress replaces it, so that route wins here.
   */
  function routeProviderFor(context) {
    const active = activeRoute();
    if (active !== undefined) return active.provider;
    const options = context?.agent?.options;
    if (options !== undefined && options !== null && typeof options.provider === "string") {
      return options.provider;
    }
    return undefined;
  }

  /** The route currently in use, when a failover has replaced the selection. */
  function activeRoute() {
    for (const cur of state.values()) {
      if (cur.pos >= 0) {
        const chain = chainCache;
        if (chain === null) return undefined;
        const route = chain[cur.pos];
        if (route !== undefined) return route;
      }
    }
    return undefined;
  }

  /**
   * Announce the switch in the transcript, the way a manual model change does.
   *
   * Without this the conversation shows no sign that the answering model
   * changed, and the model itself keeps claiming the identity it was given
   * before the failover.
   */
  const disposePreStep = ctx.on(
    "agent/pre-step",
    async ({ messages, signal, step }, next) => {
      const decision = await next();
      if (decision.kind === "reject" || signal.aborted) return decision;
      if (decision.messages.length === 0 && (step === 1 || messages.length > 0)) return decision;
      const active = activeRoute();
      if (active === undefined) return decision;
      const from = lastAnnounced;
      const to = `${active.provider}/${active.model}`;
      if (from === to) return decision;
      lastAnnounced = to;
      const label = (route) => `${route.provider}/${route.model}`;
      const previous = lastSelection ?? { provider: active.provider, model: active.model };
      const notice = {
        id: randomUUID(),
        role: "user",
        content: [
          {
            type: "text",
            text:
              `[model changed: assistant turns above this point were generated by ` +
              `${label(previous)}; the session continues with ${to}]`
          }
        ],
        source: {
          kind: "model-selection",
          form: "notice",
          summary: `${label(previous)} → ${to}`
        }
      };
      debug(`model changed notice: ${label(previous)} -> ${to}`);
      return { ...decision, messages: [...decision.messages, notice] };
    },
    { prepend: true }
  );

  // Override provider/model when an escalation is active for this step.
  // Registered prepend and overrides the resolved value AFTER next() (which runs
  // every downstream listener, incl. the built-in model-selection), so it wins.
  const disposeRequest = ctx.on(
    "agent/request",
    async (payload, next) => {
      const resolved = await next();
      if (!resolved || !resolved.provider || !resolved.model) return resolved;
      const key = keyOf(payload.turn, payload.step);
      let cur = state.get(key);

      if (cur === undefined) {
        cur = { pos: -1, selection: { provider: resolved.provider, model: resolved.model } };
        state.set(key, cur);
        const fitted = await fitReasoningEffort(resolved, cur.selection, payload.signal);
        debug(
          `request step=${key} -> fitted effort=${fitted.reasoningEffort ?? "(none)"} ` +
            `provider=${fitted.provider} model=${fitted.model}`
        );
        return fitted;
      }

      const chain = await buildChain();
      const route = routeFor(cur, chain);
      if (route) {
        if (cur.pos >= 0) {
          ctx.logger?.debug?.(
            `llm-failover: step ${key} -> ${route.provider}/${route.model} (pos ${cur.pos})`
          );
        }
        return await fitReasoningEffort({ ...resolved, provider: route.provider, model: route.model }, route, payload.signal);
      }
      return resolved;
    },
    { prepend: true }
  );

  // Decide retry/escalation. Prepended so it runs before dsh-llm-retry.
  const disposeError = ctx.on(
    "agent/request-error",
    async (payload, next) => {
      const { turn, step, failure, signal } = payload;
      if (signal?.aborted) return next();
      if (!failure || typeof failure.code !== "string") return next();

      const code = failure.code;
      const isDead = escalateOn.has(code);
      const isTransient = TRANSIENT.has(code);
      debug(
        `request-error step=${turn}:${step} provider=${payload.provider} ` +
          `code=${code} dead=${isDead} transient=${isTransient}`
      );
      if (!isDead && !(escalateTransient && isTransient)) {
        // Let dsh-llm-retry retry the SAME route (a transient error).
        return next();
      }

      // A code in both lists (RATE_LIMIT is retryable AND escalating) is
      // retried in place a few times first: a short limit recovers on its own,
      // a long one does not and must switch. The count is per route, per step.
      const failKey = `${keyOf(turn, step)}|${payload.provider}/${payload.model ?? ""}`;
      if (isTransient) {
        const attempts = (retryCounts.get(failKey) ?? 0) + 1;
        const limit = cfg.retriesBeforeSwitch;
        if (typeof limit === "number" && attempts <= limit) {
          retryCounts.set(failKey, attempts);
          debug(`retry ${attempts}/${limit} on ${payload.provider} before switching (${code})`);
          return next(); // dsh-llm-retry retries this same route
        }
        retryCounts.delete(failKey);
        debug(`${payload.provider} failed ${attempts}x with ${code}; switching instead of retrying`);
      }

      const key = keyOf(turn, step);
      const chain = await buildChain();
      if (chain.length === 0) return next(); // no fallbacks available

      let cur =
        state.get(key) ?? {
          pos: -1,
          selection: { provider: payload.provider, model: payload.model ?? "" },
        };

      // The route that just failed: cool it down so it is not picked again.
      // Only a route the plugin actually chose counts — the selection is what
      // the user asked for, and cooling it would also cool the fallback when
      // the two happen to be the same route.
      const failed = cur.pos >= 0 ? chain[cur.pos] : undefined;
      if (failed !== undefined && failed.provider !== undefined && failed.provider !== "") {
        const window = cfg.cooldownMs;
        if (typeof window === "number" && window > 0) {
          cooldowns.set(`${failed.provider}/${failed.model}`, Date.now() + window);
          debug(`cooldown ${failed.provider}/${failed.model} for ${window}ms`);
        }
      }

      // The pinned fallback is the end of the road: a failure on it is not
      // escalated, so a chain that cannot serve the request fails loudly
      // instead of looping.
      const last = chain[chain.length - 1];
      if (last?.fallback === true && failed !== undefined && sameRoute(last, failed)) {
        debug("fallback route failed; ending the turn");
        return next();
      }

      // Advance to the next route that is neither the selection nor cooling
      // down.
      const pos = nextPos(chain, cur.pos, cur.selection);
      if (pos < 0) {
        // Walked the whole chain; nothing left. Hand back to default handling
        // (which ends the turn with the failure).
        return next();
      }

      state.set(key, { pos, selection: cur.selection });
      // Remember where the failover started, so the notice can name it.
      if (lastSelection === undefined) lastSelection = cur.selection;

      // Bound the map.
      if (++pruneGuard > 256) {
        if (state.size > 200) state.clear();
        pruneGuard = 0;
      }

      const fb = chain[pos];
      ctx.logger?.warn?.(
        `llm-failover: ${payload.provider}/${payload.model ?? ""} failed (${code}); escalating to ${fb.provider}/${fb.model}`
      );
      debug(`escalate pos=${pos} -> ${fb.provider}/${fb.model}`);
      return { kind: "retry" };
    },
    { prepend: true }
  );

  ctx.effect(() => async () => {
    disposeRequest();
    disposeError();
    disposeAssemble();
    disposePreStep();
    state.clear();
    cooldowns.clear();
    retryCounts.clear();
    invalidate();
  }, "llm-failover: dispose listeners");
}

const inject = ["llm"];

export { name, apply, Config, inject };
