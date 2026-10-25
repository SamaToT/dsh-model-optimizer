# DSH LLM Failover — 模型自动优选

English | [中文](./README.md)

Automatic cost-tiered model failover for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

DeepSeek Harness ships only *same-model* retry (`@deepseek-ai/dsh-llm-retry`): when a model is transiently unavailable it retries that model, and when a model is
permanently unusable — quota exhausted, credentials rejected, no adapter
registered, context window exceeded — the turn simply ends. There is no
built-in way to continue on a different model.

This plugin adds it. When the model you selected cannot serve the request, it
switches to another one, **cheapest first**. The core rule: **walk the whole
chain to exhaustion — only report an error when every single route has
failed.** Not "try a few then give up" — every route on the chain gets its
turn, and the turn ends in error only when the last one fails too.

> **It filters on cost, not quality.** The "optimizer" in the name means "of the
> models that can serve the request, the one that costs least" — not "the
> strongest model". The free tier consults the provider's own ranking, but the
> credits and paid tiers are ordered purely by price. Keeping you running comes
> first; spending less comes second.

```
free  →  credits  →  paid
```

## What it does

- Watches the official `agent/request-error` waterfall (prepended, so it decides
  before `dsh-llm-retry`).
- On a *durable* failure code it walks a cost-ordered chain and returns
  `{ kind: "retry" }`, which makes the agent loop re-run the failed step.
- Overrides `agent/request` on the retry so the next attempt uses the new route.
- **Grades the cooldown by failure code**: a rate limit waits minutes, a rejected
  request waits much longer, a server blip waits seconds.
- **Records every route's successes and failures** (through the `llm/stream`
  waterfall) and persists them.
- **Reorders each tier by the measured success rate**: a model that keeps failing
  slides down.
- **Fits the reasoning effort** to the new model, so a switch does not fail again
  on `UNSUPPORTED_REASONING_EFFORT`.
- **Keeps the model honest about itself**: it rewrites the prompt's
  `{{provider}}` / `{{model}}` variables and appends the same
  `[model changed: …]` notice a manual switch appends.
- **Zero configuration**: on first use it enumerates every route your
  installation has and classifies each one.

The model you selected is always tried **first**. Only when it fails does the
plugin walk the chain.

## Install

```sh
dsh plugin --profile <your-profile> add dsh-model-optimizer
```

Then restart DSH. The plugin's own bundle patch registers it, so nothing else
needs editing.

> On some Desktop distributions the `desktop` profile is app-managed and the
> standalone CLI refuses `--profile desktop`. Check your distribution first.

## How it classifies a route

The plugin is provider-agnostic. It discovers your routes with
`ctx.llm.listProviders()` and `ctx.llm.listModels()`, then classifies each one
by asking, in order:

1. an explicit per-route override (`tierOverrides`);
2. an explicit per-provider override (`providerTiers`);
3. a pinned provider rule (`providerRules.<name>.pinTier`);
4. **the route's own price label** — many providers append the current rate to
   the model name (`Hy4 preview · x0.29 credits`), and a provider that
   re-evaluates promotions against the clock shows the *current* rate, so `x0.00`
   means free right now and any other rate means it costs something;
5. a price catalog the provider rule names (`providerRules.<name>.price`);
6. the provider's own tier (`providerRules.<name>.tier`);
7. the default for an unknown provider (`defaultTierForUnknown`, `paid`).

Rule 4 is what keeps the plugin provider-agnostic: a name that carries a price
is priced, whatever provider serves it.

### Built-in defaults

A few well-known providers are pre-configured, so the common setups work with
zero configuration. **They are defaults, not policy** — override any of them:

| Provider | Tier | Notes |
|---|---|---|
| `our-free-model` | free | the free lane, every model costs nothing |
| `workbuddy` | credits | free and credit-billed models; the tier follows each model's current price |
| `deepseek-account` | credits | the signed-in account's balance |
| `deepseek-official` | paid | the API key, billed per token |
| anything else | `defaultTierForUnknown` | `paid` by default, so a third-party key is never silently treated as free |

## Ordering inside a tier

The tier is the outer order. The order *inside* a tier comes from the provider's
own data, so the plugin always spends the least for the best available model:

- **Free tier** — the provider's own catalog order. Array order *is* the
  ranking; routes the ranking does not know follow the ranked ones.
- **Credits tier** — the current price, cheapest first. A model with no visible
  price sorts after every priced one.
- **Paid tier** — no public price list, so the discovery order stands.

### Then adjusted by the measured success rate (v1.6.0)

The order above is the provider's *preference*, not a *fact*. A model that fails
30% of the time still sits in front of one that never fails, so every turn pays
for the first failure.

The plugin counts each route's outcomes through the `llm/stream` waterfall
(successes, failures and rate limits all count), keeps the counters in
`statsPath` (default `~/.dsh/llm-failover-stats.json`), and reorders **inside
each tier** by that success rate. Three constraints keep it from thrashing:

1. **The tiers never move** — free always stays before credits, so the cost
   order is never broken by the success rate.
2. **An untried route is not a bad route** — a route with too few samples is
   treated as *unknown* and keeps the position the catalog gave it: it is
   neither promoted for having no data nor demoted because others failed.
3. **The score is smoothed and quantized** — the rate is smoothed with a prior
   (one lucky call cannot outrank a well-tested route) and equal scores keep
   their relative order, so the chain does not reshuffle on every outcome.

```yaml
config:
  # Where the counters are kept. Empty = memory only, nothing written.
  statsPath: "~/.dsh/llm-failover-stats.json"
  # How many recent outcomes the success rate is computed over.
  statsWindow: 50
  # How many outcomes a route needs before its rate may influence the order.
  statsMinSamples: 3
  # Off falls back to the pure catalog order.
  rankBySuccessRate: true
```

The counters are **cumulative** (`ok` / `bad`), while the rate is computed over
the most recent `statsWindow` outcomes, so a route that was reliable for a week
and started failing today is demoted quickly.

### Time-windowed free models

Some models are only free during a window (`夜间免费`, `限时免费`,
`独家限免`, `夜间折扣`). The badge in a saved catalog is static and outlives the
window, so the plugin reads the **runtime display name** instead, which the
provider re-evaluates against the clock. Inside the window a model shows `x0.00`
and is treated as free; outside it, the saved catalog's multiplier is the price
it actually charges.

## Configuration

All optional. Zero configuration works.

```yaml
config:
  # The chain, tried in order after your selection. Empty = auto-discovery.
  chain: []
  # "provider/model": "free" | "credits" | "paid"
  tierOverrides: {}
  # "provider": "free" | "credits" | "paid"
  providerTiers: {}
  # "provider": { tier, price, pinTier }
  providerRules: {}
  # Named price catalogs: "name": "~/path/to/catalog.json"
  priceCatalogs: {}
  # "provider/model": [...]
  excludeModels: []
  excludeProviders: []
  # Tier for a provider no rule knows. "paid" is the safe default.
  defaultTierForUnknown: paid
  # Skip routes the availability probe marks region-blocked / unavailable.
  skipBlockedFreeModels: true
  # { "results": { "<model id>": { "state": ... } } }
  availabilityPath: ""
  # Free tier: best-ranked model first.
  preferRanked: true
  # Credits tier: cheapest model first.
  preferCheapestCredits: true
  # The ranking catalog. Its array order is the ranking.
  rankingCatalogPath: ""
  # Write every decision to this file.
  debugLog: ""
  # Failure codes that mean "this route is unusable, try the next one".
  escalateOn:
    - QUOTA
    - ACCOUNT_QUOTA
    - AUTH
    - NO_ADAPTER
    - INVALID_CREDENTIAL
    - MISSING_CREDENTIAL
    - CONTEXT_WINDOW_EXCEEDED
    - UNSUPPORTED_REASONING_EFFORT
    - CLIENT_ERROR
    - INVALID_REQUEST
    - INVALID_MODEL_REASONING
    - RATE_LIMIT
    - REGION_BLOCKED
    - AUTHORIZATION_REQUIRED
    - IMAGE_OFFLOAD_REQUIRED
    - PI_AI_ERROR
    - UNKNOWN
  # Also switch on transient errors. Leave false: dsh-llm-retry retries those.
  escalateOnTransient: false
  # Permanent fallback: always last, and a failure on it ends the turn.
  # Leave empty to use whatever the chain ends with.
  fallback: { provider: "", model: "" }
  # How long a route that just failed is skipped, in milliseconds. 0 disables it.
  # This is the fallback for every code that `cooldownWindows` does not name.
  cooldownMs: 60000
  # Per-failure-code cooldown windows, in milliseconds. A code named here
  # replaces the built-in default for that code.
  cooldownWindows: {}
  # Where the success/failure counters are kept. Empty = memory only.
  statsPath: "~/.dsh/llm-failover-stats.json"
  # How often the counters are written to disk, in milliseconds. 0 = every outcome.
  statsFlushMs: 5000
  # How many recent outcomes the success rate is computed over.
  statsWindow: 50
  # How many outcomes a route needs before its rate may influence the order.
  statsMinSamples: 3
  # Reorder each tier by the measured success rate.
  rankBySuccessRate: true
  # The prior weight used to smooth the measured rate (higher = more conservative).
  statsPriorWeight: 8
  # Two scores closer than this keep their order (anti-thrash).
  statsRankEpsilon: 0.02
  # How long a new measurement may wait before it is used, in milliseconds.
  statsRefreshMs: 60000
  # For the listed providers, rewrite the harness identity signature in the system
  # prompt (see "Neutralize the harness identity" below). Empty = rewrite none.
  neutralizeIdentityFor: []
```

### Failure codes

| Code | Behaviour |
|---|---|
| `QUOTA`, `ACCOUNT_QUOTA`, `AUTH`, `NO_ADAPTER`, `INVALID_CREDENTIAL`, `MISSING_CREDENTIAL`, `CONTEXT_WINDOW_EXCEEDED`, `UNSUPPORTED_REASONING_EFFORT`, `CLIENT_ERROR`, `INVALID_REQUEST`, `INVALID_MODEL_REASONING`, `REGION_BLOCKED`, `AUTHORIZATION_REQUIRED`, `IMAGE_OFFLOAD_REQUIRED`, `PI_AI_ERROR` | switch to the next tier |
| `RATE_LIMIT` | retry the same route `retriesBeforeSwitch` times first, then switch |
| `UNKNOWN` | switch to the next tier |
| `SERVER`, `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE` | no switch — `dsh-llm-retry` retries the same route |

### Where failure codes come from

Four layers in the DSH ecosystem produce failure codes. The plugin routes on the
**stable code** and never parses an error message:

| Source | Codes |
|---|---|
| `dsh-llm` core | `QUOTA`, `ACCOUNT_QUOTA`, `CONTEXT_WINDOW_EXCEEDED`, `INVALID_CREDENTIAL`, `NO_ADAPTER`, `UNSUPPORTED_REASONING_EFFORT`, `IMAGE_OFFLOAD_REQUIRED`, … |
| `dsh-llm-pi-ai` | classifies an upstream HTTP status into `AUTH` / `RATE_LIMIT` / `INVALID_REQUEST` / `SERVER` / `TIMEOUT` / `TRANSPORT`; anything it cannot classify becomes `PI_AI_ERROR` |
| `dsh-our-free-model` | `REGION_BLOCKED`, `AUTHORIZATION_REQUIRED`, `CLIENT_ERROR`, … |
| DSH itself | any throw that is not a `HarnessError` is normalized to `UNKNOWN` (the UI shows it as an unexpected error) |

A code nobody has seen yet does not break the plugin — it simply does not
trigger a switch. Add its name to `escalateOn` to make it count; no code change
needed.

### The reasoning effort is fitted automatically

The effort picker offers one global list (`off` < `minimal` < `low` < `medium` <
`high` < `xhigh` < `max`), but each model supports only part of it. A mismatch
makes `dsh-llm` throw `UNSUPPORTED_REASONING_EFFORT` — and it throws that while
**resolving** the request, before the stream starts. That phase never reaches
`agent/request-error`, so the failure would end the turn instead of switching
models.

The plugin therefore aligns the effort before the request can fail, using only
the public `llm.resolveModelInfo`:

- the model accepts the level → keep it
- it does not, but accepts others → use the **highest** level it accepts (the
  efforts array keeps the escalation order, so the last entry is the highest)
- it takes no effort parameter at all (an empty effort set, or a lookup that
  throws `INVALID_MODEL_REASONING`) → drop the parameter

### A short limit retries, a lasting one switches

`RATE_LIMIT` is both retryable and escalating: a brief limit clears on its own, a
lasting one ("resets tomorrow") never will. `retriesBeforeSwitch` (default 2)
tells them apart — after that many consecutive failures on one route the plugin
stops waiting and moves on.

```yaml
config:
  retriesBeforeSwitch: 2   # 0 = switch on the first failure
```

A step that exhausts the whole chain ends the turn with the last failure, exactly
as it does today. Nothing loops.

### Permanent fallback

Without a `fallback` the chain ends with whatever the tiering ranked last —
usually the most expensive paid route. You can name the fallback yourself:

```yaml
config:
  fallback: { provider: "deepseek-official", model: "deepseek-flash" }
```

Two guarantees:

1. **It always ends the chain** — appended last even when it already appears in
   the chain.
2. **A failure on it ends the turn** — no further `retry` is returned.

That is the "when the chain can no longer serve the request, try the model you
trust most one last time and then fail honestly" case, and it is what keeps an
exhausted chain from looping.

### Cooldown (cooldownMs / cooldownWindows)

A route that just failed is not picked again while it cools down. One **flat**
window is wrong for every kind of failure:

- `RATE_LIMIT` — the quota window lasts **minutes**, so a 30s window only
  guarantees a second hit;
- `INVALID_REQUEST` (a refused signature) — **permanent**: no wait helps, but a
  short window means the plugin walks into the same wall on the next step;
- `SERVER` — 30 seconds is right.

So the plugin **grades the window by failure code**:

| Code | Default cooldown | Why |
|---|---|---|
| `RATE_LIMIT`, `QUOTA` | 5 minutes | the upstream window is minutes long |
| `ACCOUNT_QUOTA` | 15 minutes | the account balance has to be topped up by a human |
| `AUTH`, `INVALID_CREDENTIAL`, `MISSING_CREDENTIAL`, `AUTHORIZATION_REQUIRED` | 30 minutes | a human has to sign in or replace the key |
| `INVALID_REQUEST`, `CLIENT_ERROR`, `NO_ADAPTER` | 30 minutes | permanent failure |
| `REGION_BLOCKED` | 1 hour | a region restriction does not fix itself |
| `CONTEXT_WINDOW_EXCEEDED`, `INVALID_MODEL_REASONING`, `IMAGE_OFFLOAD_REQUIRED` | 10 minutes | this route cannot serve this request |
| `SERVER`, `TIMEOUT`, `TRANSPORT` | 30 seconds | a blip |
| `EMPTY_RESPONSE` | 15 seconds | a blip |
| any code not listed | `cooldownMs` (60s by default) | the fallback |

Override some of them:

```yaml
config:
  cooldownMs: 30000        # used by every code that is not listed
  cooldownWindows:
    RATE_LIMIT: 600000     # 10 minutes
    SERVER: 5000           # 5 seconds
```

A code named in `cooldownWindows` **replaces** the built-in default for that
code; every other code still uses `cooldownMs`.

So a chain walked several times does not keep hitting the same model that just
broke. The fallback is exempt from cooldown — it stays the last card.

**The route you selected yourself is cooled down too**: when your own pick is
rate-limited, it enters the cooldown and the next request does not hit it
again. A free-tier rate limit does not recover within seconds, so hammering the
same model exhausts it while the rest of the chain stays idle.

## A failover does not always land on the same model

After a failure the escalation walks **down** the cost chain instead of going
back to its head.

The chain is ordered by cost (free → credits → paid), so its head is always
the cheapest route. If every failure went back to the head, then whatever you
picked — and whatever broke it (a rate limit, a dead credential, a rejected
signature) — would end up on that one free model: it would carry every request
until its quota ran out, while dozens of other free models in the chain were
never used at all.

What actually happens: failure → that route enters the cooldown → the
escalation moves to the **next** usable route → failure again → cooldown again,
and further down. Every switch moves forward, so the load spreads over the
whole chain.

## The identity rewrite is per session

`neutralizeIdentityFor` rewrites the identity line of the provider the
**current session** is using. The decision is keyed by session id, not by
"whichever route was switched to last": with several sessions running at once,
the latter applies one session's decision to another session's request, and the
provider that needed the rewrite does not get it.

## Debug log

DSH's logger goes to the host process stdout, which the desktop app swallows, so
you cannot see why a switch did or did not happen. Set `debugLog` and every
decision is appended to that file: the discovered chain, the effort lookup for
each route, the failure code of every failed attempt, and every escalation.

```yaml
config:
  debugLog: "~/.dsh/llm-failover.log"
```

## Neutralize the harness identity (neutralizeIdentityFor)

Some upstreams gate on the **opening** of the system prompt: they expect a request
from their own client, and reject any other harness's identity signature
(`You are an AI agent powered by DeepSeek Harness.`) outright — typically surfacing
as `INVALID_REQUEST` / the upstream `11128` "request blocked". Such a provider is
**unusable** in DSH, and DSH's own `includeHarnessIdentity: false` is a **global**
switch — it would strip the identity from your other healthy models too, which is
overkill.

This plugin offers a finer blade: for the named providers only, at the
`system-prompt/assemble` stage it replaces the text of the `harness:identity`
section with a neutral sentence:

```
You are a helpful assistant.
```

Every other provider, every other section, and the conversation body are left
**byte-for-byte intact**.

```yaml
config:
  neutralizeIdentityFor:
    - workbuddy
```

### What layer it touches

```
agent-loop: systemPrompt.assemble()   ← this plugin rewrites the identity section here
        ↓
renderPrompt(assembly)                ← reads the rewritten text
        ↓
provider adapter prepareChatBody()    ← sees it is already a system message, keeps it
        ↓
the system opening sent upstream = "You are a helpful assistant."  → passes the gate
```

### When you need it

Only when a provider **stably** rejects you because of the identity signature. If the
upstream is merely rate-limiting or timing out, that is transient and belongs to
`dsh-llm-retry`; you do not need this switch.

### Caveats

- Only the text of the `harness:identity` section changes; the section count, order,
  and all other section contents are unchanged.
- If a request is mid-failover (already switched to another route), the rewrite is
  decided by the **currently active** route — switching to a provider outside the
  list will not trigger a rewrite, so healthy providers are never touched.
- This is a stopgap around an upstream channel gate, and depends on the upstream
  accepting a neutral opening line; if the upstream tightens further, adjust the
  replacement text here in step.

## Notes

- Failover is per agent step. Direct `ctx.llm.stream()` consumers are
  single-attempt and unchanged.
- Each retry re-bills input tokens on the new route.
- The plugin reads only what the providers already publish; it contacts no
  service of its own.

## License

[MIT](./LICENSE)
