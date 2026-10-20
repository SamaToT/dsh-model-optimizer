# DSH LLM Failover — 模型自动优选

English | [中文](./README.md)

Automatic cost-tiered model failover for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

DeepSeek Harness ships only *same-model* retry (`@deepseek-ai/dsh-llm-retry`): when a model is transiently unavailable it retries that model, and when a model is
permanently unusable — quota exhausted, credentials rejected, no adapter
registered, context window exceeded — the turn simply ends. There is no
built-in way to continue on a different model.

This plugin adds it. When the model you selected cannot serve the request, it
switches to another one, **cheapest first**:

```
free  →  credits  →  paid
```

## What it does

- Watches the official `agent/request-error` waterfall (prepended, so it decides
  before `dsh-llm-retry`).
- On a *durable* failure code it walks a cost-ordered chain and returns
  `{ kind: "retry" }`, which makes the agent loop re-run the failed step.
- Overrides `agent/request` on the retry so the next attempt uses the new route.
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
dsh plugin --profile <your-profile> add dsh-llm-failover
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
  # Also switch on transient errors. Leave false: dsh-llm-retry retries those.
  escalateOnTransient: false
```

### Failure codes

| Code | Behaviour |
|---|---|
| `QUOTA`, `ACCOUNT_QUOTA`, `AUTH`, `NO_ADAPTER`, `INVALID_CREDENTIAL`, `MISSING_CREDENTIAL`, `CONTEXT_WINDOW_EXCEEDED`, `UNSUPPORTED_REASONING_EFFORT` | switch to the next tier |
| `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE` | no switch — `dsh-llm-retry` retries the same route |

A step that exhausts the whole chain ends the turn with the last failure, exactly
as it does today. Nothing loops.

## Debug log

DSH's logger goes to the host process stdout, which the desktop app swallows, so
you cannot see why a switch did or did not happen. Set `debugLog` and every
decision is appended to that file: the discovered chain, the effort lookup for
each route, the failure code of every failed attempt, and every escalation.

```yaml
config:
  debugLog: "~/.dsh/llm-failover.log"
```

## Notes

- Failover is per agent step. Direct `ctx.llm.stream()` consumers are
  single-attempt and unchanged.
- Each retry re-bills input tokens on the new route.
- The plugin reads only what the providers already publish; it contacts no
  service of its own.

## License

[MIT](./LICENSE)
