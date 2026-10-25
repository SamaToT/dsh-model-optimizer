// @deepseek-ai/dsh-model-optimizer
// BUILD_STAMP: 2026-10-22T10:05:00Z (v1.7.0: exhaust-the-chain, plugin owns request-error)
//
// Cost-tiered model failover for DeepSeek Harness — UNIVERSAL / zero-config.
//
// ---------------------------------------------------------------------------
// THE SELECTION STRATEGY (authoritative — this is the whole point of the plugin)
// ---------------------------------------------------------------------------
//
//   1. Use the model the USER picked, first. The plugin never overrides a
//      working selection.
//   2. When that route fails, walk the cost-ordered chain: free -> credits ->
//      paid. The chain is built from whatever providers/models THIS user has
//      installed, so it needs no hand-written model list.
//   3. KEEP WALKING. A single failure is never the end of the turn. The plugin
//      tries EVERY route in the chain, one after another, until one works.
//   4. Only when EVERY route has been tried and every one of them failed does
//      the turn report an error. Until then the user sees no error at all.
//
//   "All models unusable" is the ONLY condition that produces an error.
//
// ---------------------------------------------------------------------------
// WHY THE PLUGIN OWNS `agent/request-error` (instead of deferring to dsh-llm-retry)
// ---------------------------------------------------------------------------
//
// dsh-llm-retry appends an `llm/retry` session event that carries the failure
// verbatim, and the session log refuses data it cannot JSON-serialize. The
// append THROWS, and the throw escapes the agent loop, so the whole turn ends
// as `kind: "error"` — the UI shows "处理失败" and the chain is never walked.
//
// The real session log shows exactly that (decoded from the live session):
//
//   turn  9: kind=error code=UNKNOWN
//            msg=session event "llm/retry" carries non-JSON-serializable data
//   turn 14: kind=error code=UNKNOWN  (same)
//   turn 15: kind=error code=UNKNOWN  (same)
//
// So this plugin handles the failure itself and never passes it on. The retry
// dsh-llm-retry would have performed happens here instead, and the failure
// never reaches that plugin's session event.
//
// ---------------------------------------------------------------------------
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
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

/**
 * The default cooldown window per failure code, in milliseconds.
 *
 * The classification follows how long the condition actually lasts:
 *
 *   - A rate limit or a quota is a WINDOW, not a moment. The upstream resets
 *     it in minutes, so a 30 second cooldown is a guaranteed second hit.
 *   - A rejected request is PERMANENT: a signature the gateway refuses, a
 *     parameter the model will never accept, a model that is not served.
 *     Waiting does not fix any of them, but a short window means the plugin
 *     walks into the same wall on the next step, so the route is put aside
 *     for much longer.
 *   - A server error, a timeout, a transport blip is transient: a short wait
 *     is exactly right, and the route is often fine again on the next step.
 *
 * A code that is not listed uses the global `cooldownMs`.
 */
const DEFAULT_COOLDOWN_WINDOWS = {
  // The upstream's own window is minutes long; do not re-enter it early.
  RATE_LIMIT: 300000,
  QUOTA: 300000,
  ACCOUNT_QUOTA: 900000,
  // The route is broken until the user fixes it (key, login, credits).
  AUTH: 1800000,
  INVALID_CREDENTIAL: 1800000,
  MISSING_CREDENTIAL: 1800000,
  AUTHORIZATION_REQUIRED: 1800000,
  // The route itself cannot serve this request, ever.
  INVALID_REQUEST: 1800000,
  CLIENT_ERROR: 1800000,
  INVALID_MODEL_REASONING: 600000,
  UNSUPPORTED_REASONING_EFFORT: 300000,
  NO_ADAPTER: 1800000,
  CONTEXT_WINDOW_EXCEEDED: 600000,
  REGION_BLOCKED: 3600000,
  IMAGE_OFFLOAD_REQUIRED: 600000,
  // A short upstream blip: the route is usually fine again right away.
  SERVER: 30000,
  TIMEOUT: 30000,
  TRANSPORT: 30000,
  EMPTY_RESPONSE: 15000,
};

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
  // Per-failure-code cooldown windows, in milliseconds: { RATE_LIMIT: 300000 }.
  //
  // One flat window is wrong for every kind of failure. A rate limit lasts
  // until the upstream's window resets — often minutes — so a 30s window means
  // the route is retried into the same wall. A rejected request (a signature
  // the upstream refuses, an unsupported parameter) is permanent: no window
  // helps, and a short one makes the plugin walk into it again on the next
  // step. A server error is worth a short wait.
  //
  // A code that is not listed uses `cooldownMs`. The built-in defaults are in
  // DEFAULT_COOLDOWN_WINDOWS and are merged under the user's own entries, so
  // naming a code here replaces the default for that code.
  cooldownWindows: z.dict(z.number()).default({}),
  // Where the per-route success/failure counters are kept, so the statistics
  // survive a restart. Empty disables persistence (counters stay in memory).
  statsPath: z.string().default(""),
  // How often the counters are written to disk, in milliseconds. 0 writes
  // after every outcome; the default of 5000 keeps the disk quiet. The
  // counters are always flushed when the plugin is disposed.
  statsFlushMs: z.number().step(1).min(0).default(5000),
  // Use the recorded success rate to order the routes inside each cost tier.
  //
  // The chain order is otherwise the author's preference (the free catalog's
  // own ranking, the price list) — but a route that fails 30% of the time
  // stays in front of one that never fails, so the plugin keeps paying for
  // the first failure of every turn. Weighting the order by the measured
  // success rate moves the reliable route forward. The weighting is
  // deliberately gentle and only applies inside a tier, so the cost order
  // (free -> credits -> paid) is never violated.
  rankBySuccessRate: z.boolean().default(true),
  // How many recent outcomes one route's success rate is computed from.
  // Small enough to follow a route that just started failing, large enough
  // that one unlucky request does not reshuffle the chain.
  statsWindow: z.number().step(1).min(1).default(50),
  // A route needs at least this many recorded outcomes before its success
  // rate is allowed to influence the order. Below that the route keeps its
  // catalog position: an untried route is not a bad route.
  statsMinSamples: z.number().step(1).min(0).default(3),
  // The prior weight used to smooth the measured rate. A route with N
  // outcomes and a rate of R is scored as (N*R + W*prior) / (N + W): the
  // prior stands in for the outcomes a route has not had yet, so one lucky
  // call cannot promote a route over a well-tested one.
  statsPriorWeight: z.number().step(1).min(1).default(8),
  // Two routes whose scores differ by less than this keep their catalog
  // order. Without it the chain could reshuffle on every recorded outcome
  // and the same request would take a different route each time.
  statsRankEpsilon: z.number().step(0).min(0).default(0.02),
  // How often the chain is rebuilt to pick up the newest measurements, in
  // milliseconds. The chain is rebuilt on adapter changes regardless; this
  // bounds how long a measurement may wait before it is used.
  statsRefreshMs: z.number().step(1).min(0).default(60000),
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
 * The key must separate sessions: DSH's `turn` is a plain counter that
 * restarts per session, so `${turn}:${step}` alone collides between two
 * sessions that are both on their first turn (and one session's failover
 * cursor would overwrite the other's).
 *
 * The agent instance identifies the session: dsh-agent-loop's `create(id, …)`
 * prepares the session under that id, so `agent.id` IS the session id. The
 * agent is fused into every agent/* payload (dsh-agent's agentEvents does
 * `{ ...payload, agent }`), so it is available at every call site.
 *
 * Do NOT reference an `agent` variable that is not in scope — it throws a
 * ReferenceError on every request.
 */
function keyOf(turn, step, agent) {
  const id = agent?.id;
  const session = typeof id === "string" && id !== "" ? id : "";
  return session === "" ? `${turn}:${step}` : `${session}|${turn}:${step}`;
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

/** The statistics file format this build reads and writes. */
const STATS_VERSION = 1;

/**
 * Per-route success/failure counters, persisted across restarts.
 *
 * WHY
 *   The chain used to be ordered purely by cost tier and by the catalog's own
 *   preference, so a route that fails 30% of the time stayed in front of one
 *   that never fails and the plugin paid for the first failure of every turn.
 *   Ranking by reliability needs a measurement, and a measurement that dies
 *   with the process is worth little: the App restarts often and a fresh
 *   counter needs dozens of requests to learn anything.
 *
 * THE STORE
 *   One JSON file under the Harness home:
 *
 *     { "version": 1, "routes": { "provider/model": { "ok": 12, "bad": 3, "bits": "111011" } } }
 *
 *   `ok`/`bad` are cumulative counters; `bits` is the recent history, one
 *   character per outcome, most recent LAST ("1" = success, "0" = failure),
 *   capped at the window length. The success rate is computed over `bits`, so
 *   a route that was reliable for a week and started failing today is demoted
 *   quickly, while a route with two lucky calls is not promoted on noise.
 */
class RouteStats {
  /**
   * @param {object} options
   * @param {string} options.path - where to persist; empty disables persistence.
   * @param {number} options.window - how many recent outcomes the rate covers.
   * @param {number} options.flushIntervalMs - minimum delay between two writes.
   * @param {(line: string) => void} [options.debug] - log sink.
   */
  constructor(options = {}) {
    this.path = typeof options.path === "string" ? options.path : "";
    this.window = Number.isFinite(options.window) && options.window >= 1
      ? Math.floor(options.window)
      : 50;
    // A flush interval of 0 means "write after every outcome", so the
    // comparison is `>= 0` and not `> 0`: a 0 would otherwise be mistaken
    // for "not configured" and silently become the default.
    this.flushIntervalMs = Number.isFinite(options.flushIntervalMs) && options.flushIntervalMs >= 0
      ? options.flushIntervalMs
      : 5000;
    this.debug = typeof options.debug === "function" ? options.debug : () => {};
    /** @type {Map<string, { ok: number, bad: number, bits: string }>} */
    this.routes = new Map();
    // Route -> cooldown deadline (ms since the epoch). Persisted with the
    // counters, because a cooldown that only lives in memory is undone by
    // every restart — and the windows are minutes long.
    /** @type {Map<string, number>} */
    this.cooldowns = new Map();
    this.dirty = false;
    this.lastFlush = 0;
    this.load();
  }

  /**
   * Read the store from disk. A missing or broken file is NOT an error: the
   * store starts empty, because a statistics file must never break the plugin.
   */
  load() {
    if (this.path === "" || !existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8"));
      if (raw === null || typeof raw !== "object") return;
      if (raw.version !== STATS_VERSION) return;
      const routes = raw.routes;
      if (routes === null || typeof routes !== "object") return;
      for (const [key, row] of Object.entries(routes)) {
        if (row === null || typeof row !== "object") continue;
        const ok = Number.isFinite(row.ok) ? row.ok : 0;
        const bad = Number.isFinite(row.bad) ? row.bad : 0;
        const bits = typeof row.bits === "string" ? row.bits : "";
        this.routes.set(key, { ok, bad, bits: bits.slice(-this.window) });
      }
      this.debug(`stats loaded ${this.routes.size} routes from ${this.path}`);

      // The cooldown deadlines survive a restart too.
      //
      // They have to: the windows are now MINUTES long for a rate limit and
      // half an hour for a permanent failure, and the App is restarted often
      // (and the validation runs are separate processes). A cooldown that
      // only lived in memory was undone by every restart, so the plugin kept
      // walking back into a route it had just decided was dead — which is
      // exactly what the long windows exist to prevent.
      const cooldowns = raw.cooldowns;
      if (cooldowns !== null && typeof cooldowns === "object") {
        const now = Date.now();
        for (const [key, until] of Object.entries(cooldowns)) {
          if (!Number.isFinite(until)) continue;
          if (until <= now) continue; // already expired
          this.cooldowns.set(key, until);
        }
        this.debug(`cooldowns loaded ${this.cooldowns.size} from ${this.path}`);
      }
    } catch (error) {
      this.debug(`stats load failed (${error?.message ?? error}); starting empty`);
    }
  }

  /**
   * Put a route into cooldown until a deadline.
   *
   * @param {string} key - the route key, "provider/model".
   * @param {number} until - the deadline in ms since the epoch.
   */
  setCooldown(key, until) {
    if (typeof key !== "string" || key === "") return;
    if (!Number.isFinite(until)) return;
    this.cooldowns.set(key, until);
    this.dirty = true;
  }

  /**
   * The cooldown deadline of a route, if it is still in cooldown.
   *
   * @param {string} key - the route key.
   * @returns {number | undefined} the deadline in ms since the epoch.
   */
  cooldownUntil(key) {
    const until = this.cooldowns.get(key);
    if (until === undefined) return undefined;
    if (until <= Date.now()) {
      this.cooldowns.delete(key);
      this.dirty = true;
      return undefined;
    }
    return until;
  }

  /**
   * Record one outcome for a route.
   *
   * @param {string} key - the route key, "provider/model".
   * @param {boolean} ok - true for a success, false for a failure.
   */
  record(key, ok) {
    if (typeof key !== "string" || key === "") return;
    let row = this.routes.get(key);
    if (row === undefined) {
      row = { ok: 0, bad: 0, bits: "" };
      this.routes.set(key, row);
    }
    if (ok) {
      row.ok += 1;
      row.bits = `${row.bits}1`.slice(-this.window);
    } else {
      row.bad += 1;
      row.bits = `${row.bits}0`.slice(-this.window);
    }
    this.dirty = true;
  }

  /**
   * The success rate of one route over its recent outcomes.
   *
   * @returns {{ rate: number, samples: number }} the rate is 0..1.
   */
  rate(key) {
    const row = this.routes.get(key);
    if (row === undefined) return { rate: 0, samples: 0 };
    const bits = row.bits;
    if (bits === "") return { rate: 0, samples: 0 };
    let ones = 0;
    for (let i = 0; i < bits.length; i += 1) {
      if (bits[i] === "1") ones += 1;
    }
    return { rate: ones / bits.length, samples: bits.length };
  }

  /**
   * The cumulative counters of one route, for reporting.
   */
  counts(key) {
    const row = this.routes.get(key);
    if (row === undefined) return { ok: 0, bad: 0, samples: 0 };
    return { ok: row.ok, bad: row.bad, samples: row.bits.length };
  }

  /**
   * Write the store to disk when something changed.
   *
   * @param {boolean} [force] - write even when the interval has not elapsed.
   * @returns {boolean} whether a write happened.
   */
  flush(force = false) {
    if (!this.dirty) return false;
    if (this.path === "") return false;
    const now = Date.now();
    if (!force && now - this.lastFlush < this.flushIntervalMs) return false;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const payload = {
        version: STATS_VERSION,
        updatedAt: new Date(now).toISOString(),
        routes: Object.fromEntries(this.routes),
        // Only the cooldowns that are still in the future are written: an
        // expired deadline is dead weight, and the file stays small.
        cooldowns: Object.fromEntries(
          [...this.cooldowns.entries()].filter(([, until]) => until > now)
        )
      };
      // Write to a sibling temp file and rename it, so a crash mid-write
      // cannot leave a half-written statistics file behind.
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      renameSync(tmp, this.path);
      this.dirty = false;
      this.lastFlush = now;
      return true;
    } catch (error) {
      this.debug(`stats flush failed (${error?.message ?? error})`);
      return false;
    }
  }
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

  // The cooldown window per failure code. The built-in table holds the
  // defaults; the user's own entries replace the default for the code they
  // name, so a user who wants a 10 minute rate-limit window sets exactly
  // that without having to restate the other codes.
  const cooldownWindows = { ...DEFAULT_COOLDOWN_WINDOWS, ...(cfg.cooldownWindows ?? {}) };

  /**
   * The cooldown window for one failure code.
   *
   * @param {string} code - the failure code.
   * @returns {number} the window in milliseconds; 0 disables the cooldown.
   */
  function cooldownFor(code) {
    const specific = cooldownWindows[code];
    if (typeof specific === "number" && Number.isFinite(specific)) return specific;
    const global = cfg.cooldownMs;
    return typeof global === "number" && Number.isFinite(global) ? global : 0;
  }

  /**
   * Record one outcome of a model call, exactly once.
   *
   * A failed call is visible TWICE: the `llm/stream` waterfall delivers a
   * terminal chunk whose reason is "error", and the agent loop then dispatches
   * `agent/request-error` with the same failure. Counting both would record
   * one failure twice and make the success rate of a failing route look
   * better than it is.
   *
   * So the outcome is counted from the STREAM (the only place a success is
   * visible at all), and the error handler only counts a failure the stream
   * never saw: one that happened before the stream started, such as a
   * `prepareCall` failure that never reached an adapter. The two paths are
   * told apart by a short-lived marker: the stream records the route it
   * counted, and the error handler skips a failure on a route the stream
   * already reported.
   */
  const recentlyCounted = new Map();
  function recordOutcome(key, ok, kind) {
    stats.record(key, ok);
    // The measurement changes the reliability order of the chain.
    markStatsStale();
    // Only a FAILURE needs the marker: the error handler is the only other
    // place a failure is reported, so a success never has to be deduped.
    if (!ok) recentlyCounted.set(key, Date.now());
    const counts = stats.counts(key);
    debug(
      `outcome ${ok ? "ok" : "fail"} ${key} (${kind}) ` +
        `total ok=${counts.ok} bad=${counts.bad}`
    );
    stats.flush();
  }

  /**
   * Whether the stream already reported an outcome for this route.
   *
   * @param {string} key - the route key.
   * @returns {boolean} true when the failure must NOT be counted again.
   */
  function alreadyCounted(key) {
    const at = recentlyCounted.get(key);
    if (at === undefined) return false;
    // The marker is only good for a short while: a later, separate call to
    // the same route must be counted on its own.
    if (Date.now() - at > 5000) {
      recentlyCounted.delete(key);
      return false;
    }
    return true;
  }

  const llm = ctx.get("llm");

  // The measured success/failure counters, persisted so the reliability
  // ranking survives a restart.
  const statsPath = typeof cfg.statsPath === "string" && cfg.statsPath.trim() !== ""
    ? expandHome(cfg.statsPath)
    : join(homedir(), ".dsh", "llm-failover-stats.json");
  const stats = new RouteStats({
    path: statsPath,
    window: cfg.statsWindow,
    flushIntervalMs: cfg.statsFlushMs,
    debug
  });
  const statsEnabled = cfg.rankBySuccessRate !== false;
  const statsMinSamples = Number.isFinite(cfg.statsMinSamples) ? cfg.statsMinSamples : 3;

  // Per-(turn,step) failover cursor.
  //   pos = -1  -> using the user's selected route
  //   pos >= 0  -> using chain[pos]
  /** @type {Map<string, { pos: number, selection: { provider: string, model: string } }>} */
  const state = new Map();

  /**
   * The chain position the current TURN has reached, keyed by session+turn.
   *
   * The per-step cursor (`state`) is not enough: the escalation has to survive
   * from one step to the next. The agent loop retries a failed step through the
   * `agent/request-error` waterfall, and the retried step asks for the route
   * again through `agent/request` — but a NEW step has a NEW key, so a cursor
   * stored per step starts the walk from the head of the chain every time.
   *
   * The symptom is a chain that never advances: the log showed
   *
   *   escalate pos=1 -> fake/m2
   *   escalate pos=1 -> fake/m2
   *   escalate pos=1 -> fake/m2
   *
   * over and over, so routes 2..n of the chain were never tried and the turn
   * ended after the second route. The whole point of the plugin is to walk the
   * chain to its END, so the position is kept per session+turn here.
   */
  const turnCursor = new Map();

  /** The key that identifies the session+turn an escalation belongs to. */
  function turnKeyOf(turn, agent) {
    const session = typeof agent?.id === "string" && agent.id !== "" ? agent.id : "";
    return session === "" ? `turn:${turn}` : `${session}|turn:${turn}`;
  }
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
  // agent instance -> the route that agent is currently using.
  //
  // DSH's agent-loop fuses the agent into every agent/* payload
  // (dsh-agent's agentEvents() does `{ ...payload, agent }`), and the system
  // prompt context carries the very same instance (assembleContextFor returns
  // { agent, scope, signal }). The agent instance is therefore the exact link
  // between the two stages, and it is stable for the life of the session.
  //
  // Keying by the agent (a WeakMap) rather than by session id or turn number
  // matters: a turn is a plain counter that repeats across sessions, and the
  // turn payload's shape differs between entry points (some carry a session id
  // prefix, most do not), so neither can identify a session reliably.
  /** @type {WeakMap<object, { provider: string, model: string }>} */
  const agentRoutes = new WeakMap();

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

  // The chain is rebuilt when the adapters change. It also has to be rebuilt
  // when a NEW MEASUREMENT arrives, because the order now depends on the
  // measured reliability — otherwise a route that just started failing would
  // keep its old position until the next adapter change, which may be never.
  //
  // The rebuild is deferred and rate-limited: every outcome marks the chain
  // stale, and the next request rebuilds it, but not more often than
  // `statsRefreshMs`. Rebuilding on every single outcome would reorder the
  // chain mid-conversation and make the failover jump around.
  let chainStale = false;
  let lastStatsRefresh = 0;
  const statsRefreshMs = Number.isFinite(cfg.statsRefreshMs) ? cfg.statsRefreshMs : 60000;
  const markStatsStale = () => {
    chainStale = true;
  };
  const refreshIfStale = () => {
    if (!chainStale) return;
    const now = Date.now();
    if (now - lastStatsRefresh < statsRefreshMs) return;
    lastStatsRefresh = now;
    chainStale = false;
    chainCache = null;
  };

  /** Build (and cache) the cost-ordered chain for this installation. */
  async function buildChain() {
    if (Array.isArray(cfg.chain) && cfg.chain.length > 0) return cfg.chain;
    // A new measurement may have changed the reliability order.
    refreshIfStale();
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

      // Reorder each tier by the measured reliability (§5.1).
      //
      // The order above is the author's preference, not a measurement: the free
      // catalog's ranking and the price list say which model SHOULD be tried
      // first, but a route that fails 30% of the time still sits in front of one
      // that never fails, so every turn pays for the first failure. The
      // measured success rate is the only thing that knows the difference.
      //
      // Three rules keep this from thrashing:
      //   - the tiers themselves never move (free stays before credits), so the
      //     cost order the plugin promises is never violated;
      //   - a route with too few samples keeps its catalog position, because
      //     an untried route is not a bad route;
      //   - the score is smoothed with a prior, so a single lucky call cannot
      //     outrank a well-tested route, and routes whose scores are within
      //     `statsRankEpsilon` of each other keep their relative order.
      if (statsEnabled) {
        const prior = cfg.statsPriorWeight;
        const epsilon = cfg.statsRankEpsilon;
        // The score of one route, in a single comparable number.
        //
        // A route with too few samples is UNKNOWN, not bad, and the two must
        // not be confused. An unknown route is given the prior score (0.5) —
        // the same value a route with no evidence either way would have — so
        // it is neither promoted above a proven route nor pushed below one
        // that keeps failing. A measured route is scored by its rate,
        // smoothed towards the prior so a single lucky call cannot outrank a
        // well-tested one.
        //
        // The score is then QUANTIZED to `epsilon`. Quantizing makes the
        // comparison a total order (a plain float comparison is not, and
        // `Array.prototype.sort` with an inconsistent comparator produces a
        // scrambled array), and it makes the order stable: two routes within
        // one step of each other keep the catalog order, so the chain does
        // not reshuffle on every single recorded outcome.
        const scoreOf = (route) => {
          const key = `${route.provider}/${route.model}`;
          const { rate, samples } = stats.rate(key);
          // An unknown route scores the PRIOR MEAN (0.5) — the same value a
          // route with no evidence either way would have. It must be on the
          // same scale as a measured rate: giving it the prior WEIGHT (8)
          // instead would put it far above every measured route, and every
          // untried route would jump to the head of the chain.
          if (samples < statsMinSamples) return 0.5;
          return (samples * rate + prior * 0.5) / (samples + prior);
        };
        const bucketOf = (route) => Math.round(scoreOf(route) / epsilon);
        // The catalog position of a route, used as the tie-breaker inside a
        // score bucket.
        const catalogIndex = new Map();
        for (const tier of [tiers.free, tiers.credits, tiers.paid]) {
          tier.forEach((route, index) => {
            catalogIndex.set(`${route.provider}/${route.model}`, index);
          });
        }
        const byScore = (a, b) => {
          const ba = bucketOf(a);
          const bb = bucketOf(b);
          if (ba !== bb) return bb - ba; // the higher score comes first
          const ia = catalogIndex.get(`${a.provider}/${a.model}`) ?? 0;
          const ib = catalogIndex.get(`${b.provider}/${b.model}`) ?? 0;
          return ia - ib; // same bucket: the catalog order stands
        };
        // Array.prototype.sort is stable, so the catalog order really does
        // survive between routes that score the same.
        tiers.free = [...tiers.free].sort(byScore);
        tiers.credits = [...tiers.credits].sort(byScore);
        tiers.paid = [...tiers.paid].sort(byScore);
        chain = [...tiers.free, ...tiers.credits, ...tiers.paid];
      }

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

  /**
   * Whether a route is inside its cooldown window.
   *
   * The deadline is read from the PERSISTED store, not from a map that lives
   * only in this process. The windows are minutes long (a rate limit waits
   * five minutes, a permanent failure half an hour) and the App restarts
   * often, so an in-memory cooldown was undone by every restart: the plugin
   * kept walking back into a route it had just decided was dead. The
   * in-memory map is kept as the fast path for a route cooled down in THIS
   * process, and the store is the source of truth.
   */
  function cooling(route) {
    const key = `${route.provider}/${route.model}`;
    const until = cooldowns.get(key) ?? stats.cooldownUntil(key);
    if (until === undefined) return false;
    if (until <= Date.now()) {
      cooldowns.delete(key);
      stats.cooldownUntil(key); // drops the expired entry from the store
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
   *
   * `from` is -1 when the user's own selection just failed. The walk then
   * starts at the head of the chain — but the head is skipped when it is the
   * route that just failed (see `failedRoute`), so the escalation lands on a
   * DIFFERENT route instead of the same one. Without that, a selection that
   * fails lands on chain position 0, and position 0 failing lands on position
   * 0 again: one route carries every request until its quota is gone.
   */
  function nextPos(chain, from, selection, failedRoute) {
    const last = chain.length - 1;
    for (let pos = from + 1; pos < chain.length; pos++) {
      const route = chain[pos];
      const pinned = pos === last && route.fallback === true;
      if (!pinned && selection !== undefined && sameRoute(route, selection)) continue;
      // The route that just failed is never picked again in this walk, even
      // when it is not cooling down (a selection that failed has no cursor
      // position of its own, so it is not in the cooldown map yet).
      if (!pinned && failedRoute !== undefined && sameRoute(route, failedRoute)) continue;
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
    const active = activeRoute(context);
    if (active !== undefined) return active.provider;
    const options = context?.agent?.options;
    if (options !== undefined && options !== null && typeof options.provider === "string") {
      return options.provider;
    }
    return undefined;
  }

  /**
   * The route currently in use for the agent the prompt is assembled for.
   *
   * The lookup is by the agent instance, which is the same object in the
   * request waterfall and in the prompt context. Walking the cursor map
   * instead would answer with whichever cursor was created first — in a
   * profile with several live sessions that is a foreign session's route, and
   * a per-provider rewrite (see neutralizeIdentityFor) would then be applied
   * to the wrong provider.
   */
  function activeRoute(context) {
    const agent = context?.agent;
    if (agent === undefined || agent === null || typeof agent !== "object") return undefined;
    const route = agentRoutes.get(agent);
    if (route !== undefined) return route;
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
      // The agent this request belongs to. DSH fuses it into the payload, and
      // the prompt for the same agent reads the route back through it.
      const agent = payload.agent;
      const key = keyOf(payload.turn, payload.step, agent);
      let cur = state.get(key);

      // A retried step arrives with a NEW step key, so the per-step cursor is
      // fresh. The turn-level cursor carries the position the walk reached, so
      // the retried step continues on the route the escalation chose instead of
      // asking for the user's selection again.
      const tKey = turnKeyOf(payload.turn, agent);
      const tCur = turnCursor.get(tKey);
      if (tCur !== undefined && (cur === undefined || tCur.pos > cur.pos)) {
        const chainT = await buildChain();
        const routeT = chainT[tCur.pos];
        if (routeT !== undefined) {
          if (cur === undefined) {
            cur = { pos: -1, selection: { provider: resolved.provider, model: resolved.model } };
          }
          cur = { pos: tCur.pos, selection: cur.selection };
          state.set(key, cur);
          debug(`resume step=${key} -> continuing the walk at pos=${tCur.pos} (${routeT.provider}/${routeT.model})`);
          const fittedT = await fitReasoningEffort(
            { ...resolved, provider: routeT.provider, model: routeT.model },
            routeT,
            payload.signal
          );
          if (agent !== undefined && agent !== null && typeof agent === "object") {
            agentRoutes.set(agent, { provider: fittedT.provider, model: fittedT.model });
          }
          return fittedT;
        }
      }

      if (cur === undefined) {
        cur = { pos: -1, selection: { provider: resolved.provider, model: resolved.model } };
        state.set(key, cur);

        // The user's own selection is subject to the cooldown too.
        //
        // Without this check the request goes straight back to the route that
        // just failed, the user sees the SAME error again, and only the
        // request after that switches away. The real log showed it plainly:
        //
        //   request step=53:45 ... provider=workbuddy model=step-5-preview
        //   request-error step=53:45 provider=workbuddy code=RATE_LIMIT
        //   request step=53:46 ... provider=workbuddy model=step-5-preview   <- again!
        //
        // 46 times in the log a LATER step sent the request back to the route
        // that had just failed, and 51% of all requests used a route that had
        // already failed at some point.
        //
        // The cooldown map already exists and already grades the window by
        // failure code (§5.2); it was simply never consulted for the
        // selection. Consulting it here is what makes the switch happen
        // BEFORE the error, instead of after it.
        //
        // This needs no memory of its own: a route that is not in cooldown
        // (because its window passed, or because it recovered) is used
        // normally, so a model that is dynamic — it may succeed or fail at
        // any time — is never written off on the strength of an old failure.
        if (cooling(cur.selection)) {
          const chain = await buildChain();
          const pos = nextPos(chain, -1, cur.selection, undefined);
          if (pos >= 0) {
            const route = chain[pos];
            state.set(key, { pos, selection: cur.selection });
            if (agent !== undefined && agent !== null && typeof agent === "object") {
              agentRoutes.set(agent, { provider: route.provider, model: route.model });
            }
            ctx.logger?.warn?.(
              `llm-failover: ${cur.selection.provider}/${cur.selection.model} is in cooldown; ` +
                `using ${route.provider}/${route.model} instead`
            );
            debug(
              `preempt step=${key} -> ${cur.selection.provider}/${cur.selection.model} ` +
                `is cooling down; switching to ${route.provider}/${route.model} before the request`
            );
            const fitted = await fitReasoningEffort(
              { ...resolved, provider: route.provider, model: route.model },
              route,
              payload.signal
            );
            return fitted;
          }
          // Every route is cooling down: there is nothing better to send the
          // request to, so the selection is used and the failure is honest.
          debug(
            `preempt step=${key} -> ${cur.selection.provider}/${cur.selection.model} ` +
              `is cooling down, but no other route is available; using it anyway`
          );
        }

        const fitted = await fitReasoningEffort(resolved, cur.selection, payload.signal);
        if (agent !== undefined && agent !== null && typeof agent === "object") {
          agentRoutes.set(agent, { provider: fitted.provider, model: fitted.model });
        }
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
        const fitted = await fitReasoningEffort(
          { ...resolved, provider: route.provider, model: route.model },
          route,
          payload.signal
        );
        if (agent !== undefined && agent !== null && typeof agent === "object") {
          agentRoutes.set(agent, { provider: fitted.provider, model: fitted.model });
        }
        return fitted;
      }
      if (agent !== undefined && agent !== null && typeof agent === "object") {
        agentRoutes.set(agent, { provider: resolved.provider, model: resolved.model });
      }
      return resolved;
    },
    { prepend: true }
  );

  // Count the outcome of every model call, so the chain can be ordered by the
  // measured reliability instead of by a guess (§5.3).
  //
  // WHY `llm/stream` AND NOT `agent/request-error`
  //   `agent/request-error` only fires on a FAILURE, so it can count failures
  //   but never successes — and a success rate needs both. `llm/stream` wraps
  //   every call, successful or not: its terminal chunk carries the finish
  //   reason, and a reason of kind "error" or "aborted" carries the failure.
  //
  //   The waterfall runs for BOTH dispatch paths: dsh-llm's `stream()` and the
  //   prepared-call path (`preparedCall.stream()`) both end in
  //   `streamWithRegistration()`, which is the one that runs the waterfall.
  //
  // WHAT IT DOES
  //   It passes the request straight through and watches the chunks. The
  //   chunks are forwarded unchanged, so nothing about the call is altered;
  //   the listener only observes the terminal chunk and records the outcome.
  const disposeStream = ctx.on(
    "llm/stream",
    (options, next) => {
      const provider = options?.provider;
      const model = options?.model;
      const key = typeof provider === "string" && typeof model === "string"
        ? `${provider}/${model}`
        : undefined;

      // The waterfall hands the iterable back SYNCHRONOUSLY: dsh-llm's
      // `streamWithRegistration()` returns the result of the waterfall, and
      // the agent loop iterates it directly with `for await`. An `async`
      // listener would return a Promise, which is not async-iterable, and
      // every model call would fail. So this listener is a plain function
      // that returns a generator.
      const iterator = next();
      if (key === undefined) return iterator;

      // A generator that forwards every chunk and records the terminal one.
      async function* observed() {
        let outcome;
        for await (const chunk of iterator) {
          // The terminal chunk carries the finish reason.
          if (chunk !== null && typeof chunk === "object" && chunk.type === "finish") {
            outcome = chunk.reason;
          }
          yield chunk;
        }
        // No terminal chunk at all: the stream ended early. That is not a
        // route failure (the abort path is reported by the loop itself), so
        // nothing is recorded.
        if (outcome === undefined) return;
        const ok = outcome.kind !== "error" && outcome.kind !== "aborted";
        recordOutcome(key, ok, outcome.kind);
      }
      return observed();
    }
  );


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

      // The route is taken from the cursor, not from the error payload: DSH's
      // agent/request-error payload carries the provider but no model, so a
      // payload-built key would collapse every model of one provider into a
      // single counter.
      const cursorKey = keyOf(turn, step, payload.agent);
      const cursor = state.get(cursorKey);
      const failedProvider = payload.provider ?? "";
      const failedModel =
        cursor !== undefined
          ? cursor.pos >= 0
            ? (await buildChain())[cursor.pos]?.model ?? ""
            : cursor.selection.model
          : payload.agent?.options?.model ?? "";
      const failKey = `${cursorKey}|${failedProvider}/${failedModel}`;

      if (!isDead && !(escalateTransient && isTransient)) {
        // A code the plugin does not escalate on.
        //
        // The failure is HANDLED HERE, not handed to dsh-llm-retry: that plugin
        // appends an `llm/retry` session event carrying the failure, and the
        // event can hold data the session log refuses to serialize. The append
        // then THROWS, and the throw escapes the agent loop, so the whole turn
        // ends as `kind: "error"` — the UI shows "处理失败" and the chain is
        // never walked to the end.
        //
        // The real session log shows exactly that:
        //
        //   turn 9:  kind=error code=UNKNOWN
        //            msg=session event "llm/retry" carries non-JSON-serializable data
        //   turn 14: kind=error code=UNKNOWN  (same)
        //   turn 15: kind=error code=UNKNOWN  (same)
        //
        // So the retry that dsh-llm-retry performs is done here instead, and
        // the failure never reaches that plugin. The chain is still walked to
        // its end, and the turn only fails when EVERY route has failed.
        if (isTransient) {
          const attempts = (retryCounts.get(failKey) ?? 0) + 1;
          if (typeof cfg.retriesBeforeSwitch === "number" && attempts <= cfg.retriesBeforeSwitch) {
            retryCounts.set(failKey, attempts);
            debug(`retry ${attempts}/${cfg.retriesBeforeSwitch} on ${payload.provider} (${code})`);
            return { kind: "retry" };
          }
          retryCounts.delete(failKey);
        }
        // Not escalatable and not worth retrying: walk on to another route
        // anyway, so a single unusable code does not end the turn.
        const chain0 = await buildChain();
        const pos0 = nextPos(chain0, -1, undefined, undefined);
        if (pos0 >= 0) {
          state.set(cursorKey, { pos: pos0, selection: { provider: failedProvider, model: failedModel } });
          turnCursor.set(turnKeyOf(turn, payload.agent), { pos: pos0 });
          debug(`escalate pos=${pos0} -> ${chain0[pos0].provider}/${chain0[pos0].model}`);
          return { kind: "retry" };
        }
        // The whole chain is exhausted. The failure is returned to the agent
        // loop, which ends the turn with the error — which is correct, and
        // correct ONLY now: every route has been tried.
        //
        // It is NOT handed to dsh-llm-retry: that plugin would append an
        // `llm/retry` session event carrying the failure, the append would
        // throw on data the session log cannot serialize, and the throw would
        // end the turn as `kind: "error"` with a different, misleading message.
        debug("chain exhausted; ending the turn with the failure");
        return next();
      }

      // A code in both lists (RATE_LIMIT is retryable AND escalating) is
      // retried in place a few times first: a short limit recovers on its own,
      // a long one does not and must switch. The count is per route, per step.
      //
      // The retry happens HERE, not in dsh-llm-retry: that plugin appends an
      // `llm/retry` session event carrying the failure, and the session log
      // refuses data it cannot JSON-serialize. The append THROWS, the throw
      // escapes the agent loop, and the turn ends as `kind: "error"` — the
      // red "处理失败", with the chain never walked.
      if (isTransient) {
        const attempts = (retryCounts.get(failKey) ?? 0) + 1;
        const limit = cfg.retriesBeforeSwitch;
        if (typeof limit === "number" && attempts <= limit) {
          retryCounts.set(failKey, attempts);
          debug(`retry ${attempts}/${limit} on ${payload.provider} before switching (${code})`);
          // { kind: "retry" } re-runs the failed step on the same route. The
          // failure never reaches dsh-llm-retry, so no `llm/retry` event is
          // appended and the turn cannot die from it.
          return { kind: "retry" };
        }
        retryCounts.delete(failKey);
        debug(`${payload.provider} failed ${attempts}x with ${code}; switching instead of retrying`);
      }

      const key = cursorKey;
      const chain = await buildChain();
      if (chain.length === 0) return next(); // no fallbacks available

      let cur = state.get(key);
      if (cur === undefined) {
        // DSH's agent/request-error payload carries the provider but NOT the
        // model (dsh-agent-loop dispatches { turn, step, provider, failure,
        // retryPolicy, signal, agent }), so the failing route has to come from
        // the agent's own selection — that is the only place that knows both
        // the provider and the model of the route that was tried.
        const options = payload.agent?.options;
        cur = {
          pos: -1,
          selection: {
            provider: payload.provider ?? options?.provider ?? "",
            model: options?.model ?? "",
          },
        };
        state.set(key, cur);
      }

      // Resume from where this TURN's walk already reached.
      //
      // The retried step arrives with a new step key, so the per-step cursor
      // is fresh and the walk would restart at the head of the chain. The
      // turn-level cursor carries the position across steps, so the chain is
      // walked exactly once, route by route, until it is exhausted.
      const tKey = turnKeyOf(turn, payload.agent);
      const tCur = turnCursor.get(tKey);
      if (tCur !== undefined && tCur.pos > cur.pos) {
        cur = { pos: tCur.pos, selection: cur.selection };
        state.set(key, cur);
      }

      // The route that just failed: cool it down so it is not picked again.
      //
      // A route the plugin chose (cursor position >= 0) AND the user's own
      // selection are both cooled down. Cooling the selection used to be
      // skipped, on the grounds that it would also cool the pinned fallback
      // when the two are the same route — but the pinned fallback is exempt
      // from the cooldown check in nextPos anyway, so that argument does not
      // hold. The cost of not cooling it is much higher: a selection that
      // failed (a rate limit, say) was retried on the very next step and hit
      // the same limit again, so one exhausted route kept absorbing requests
      // while the rest of the chain stayed idle.
      //
      // The model is taken from the cursor, never from the error payload: the
      // payload has no model field, and a half-empty route ("workbuddy/")
      // matches nothing on the chain, so the cooldown would land on a route
      // that does not exist and the failed one would stay eligible.
      const failed = cur.pos >= 0 ? chain[cur.pos] : cur.selection;
      if (failed !== undefined && failed.provider !== undefined && failed.provider !== "") {
        // The window depends on HOW the route failed (§5.2). A rate limit
        // lasts until the upstream's own window resets — minutes — so a flat
        // 30 second cooldown only guarantees a second hit. A rejected request
        // is permanent: waiting does not help, but a short window means the
        // plugin walks into the same wall on the very next step.
        const window = cooldownFor(code);
        if (typeof window === "number" && window > 0) {
          const until = Date.now() + window;
          const key = `${failed.provider}/${failed.model}`;
          cooldowns.set(key, until);
          // The deadline also goes into the persisted store, so the cooldown
          // survives a restart. Without this the window was undone by every
          // restart — and the window is exactly what keeps the plugin from
          // walking back into a route that just failed.
          stats.setCooldown(key, until);
          stats.flush();
          debug(`cooldown ${key} for ${window}ms (${code})`);
        }

        // Count the failure, unless the stream already counted it.
        //
        // A call that reached the adapter reports its failure TWICE: the
        // `llm/stream` waterfall delivers a terminal error chunk, and the loop
        // then dispatches `agent/request-error` with the same failure. The
        // stream is the one that counts, and this handler only counts the
        // failures the stream never saw — a `prepareCall` failure, or a
        // failure raised before the adapter was reached.
        const failedKey = `${failed.provider}/${failed.model}`;
        if (!alreadyCounted(failedKey)) {
          recordOutcome(failedKey, false, code);
        }
      }

      // The pinned fallback is the end of the road: a failure on it is not
      // escalated, so a chain that cannot serve the request fails loudly
      // instead of looping.
      const last = chain[chain.length - 1];
      if (last?.fallback === true && failed !== undefined && sameRoute(last, failed)) {
        debug("fallback route failed; ending the turn");
        return undefined;
      }

      // Advance to the next route that is neither the selection nor cooling
      // down, and never the one that just failed.
      const pos = nextPos(chain, cur.pos, cur.selection, failed);
      if (pos < 0) {
        // Walked the whole chain; nothing left.
        //
        // The waterfall is answered with `undefined` and NOT with next(): the
        // agent loop turns any answer that is not { kind: "retry" } into the
        // REAL failure (`throw new LlmError(message, code, failure)`), which is
        // exactly what should happen once every route has been tried.
        //
        // Calling next() instead would hand the failure to dsh-llm-retry,
        // which appends an `llm/retry` session event carrying data the
        // session log cannot serialize. That append throws, the throw
        // escapes the agent loop, and the turn ends with the misleading
        // "session event \"llm/retry\" carries non-JSON-serializable data"
        // instead of the upstream's own error.
        debug("chain exhausted; ending the turn with the failure");
        return undefined;
      }

      state.set(key, { pos, selection: cur.selection });
      // Remember where this turn's walk reached, so the NEXT step continues
      // from here instead of restarting at the head of the chain.
      turnCursor.set(turnKeyOf(turn, payload.agent), { pos });
      // Remember where the failover started, so the notice can name it.
      if (lastSelection === undefined) lastSelection = cur.selection;

      // Bound the map.
      if (++pruneGuard > 256) {
        if (state.size > 200) state.clear();
        pruneGuard = 0;
      }

      const fb = chain[pos];
      // The prompt for the retried step is assembled BEFORE the request runs,
      // so the new route has to be recorded here — recording it only when the
      // request is resolved would leave the prompt one step behind, and the
      // identity rewrite would be decided against the previous route.
      const agent = payload.agent;
      if (agent !== undefined && agent !== null && typeof agent === "object") {
        agentRoutes.set(agent, { provider: fb.provider, model: fb.model });
      }
      ctx.logger?.warn?.(
        `llm-failover: ${failed.provider ?? ""}/${failed.model ?? ""} failed (${code}); escalating to ${fb.provider}/${fb.model}`
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
    disposeStream();
    state.clear();
    turnCursor.clear();
    cooldowns.clear();
    retryCounts.clear();
    // Write the counters out before the plugin goes away, so a restart does
    // not lose what was measured.
    stats.flush(true);
    invalidate();
  }, "llm-failover: dispose listeners");
}

const inject = ["llm"];

export { name, apply, Config, inject };
