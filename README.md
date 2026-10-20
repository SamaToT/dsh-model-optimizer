# DSH LLM Failover — 模型自动优选

[English](./README.en.md) | 中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**成本分层自动模型切换**插件。

DSH 自带的重试只会重试**同一个模型**（`@deepseek-ai/dsh-llm-retry`）：瞬态错误会重试该模型，
而模型彻底不可用时——额度耗尽、凭据被拒、适配器未注册、上下文窗口超限——这一轮就直接失败结束。
没有内置的"换个模型继续"能力。

本插件补上这件事。当你选的模型无法完成请求时，它自动切换到另一个模型，
**优先用最便宜的**：

> **它筛的是成本，不是质量。** 名字里的「优选」指「在能用的模型里选消耗最低的那个」，
> 不指「选最强的模型」。免费档内会参考 provider 自己的排名，但积分档和付费档完全按
> 价格升序走——它首先保证你能继续跑，其次才是少花钱。

```
免费  →  积分  →  付费
```

## 功能

- 监听官方 `agent/request-error` 瀑布流（`prepend`，先于 `dsh-llm-retry` 决策）。
- 遇到**持续性**失败码时沿成本链走一步并返回 `{ kind: "retry" }`，让 agent 重跑该步骤。
- 重试时覆盖 `agent/request`，使下一次请求走新路由。
- **自动适配推理档位**（reasoning effort），避免切换后因
  `UNSUPPORTED_REASONING_EFFORT` 再次失败。
- **让模型如实报身份**：覆盖系统提示里的 `{{provider}}` / `{{model}}` 变量，
  并追加与手动切换一致的 `[model changed: …]` 提示。
- **零配置**：首次使用时自动枚举你安装的所有路由并分层。

你在 composer 里选的模型永远**先试**。只有它失败，插件才会往下走。

## 安装

```sh
dsh plugin --profile <你的 profile> add dsh-model-optimizer
```

然后重启 DSH。插件自带的 bundle patch 会完成注册，不需要改任何配置。

> 部分 Desktop 发行版的 `desktop` profile 由 App 管理，独立 CLI 会拒绝
> `--profile desktop`。请先确认你用的发行版。

## 怎么给一个路由分层

插件是**provider 无关**的。它用 `ctx.llm.listProviders()` 和
`ctx.llm.listModels()` 发现你的路由，然后按顺序询问：

1. 显式的单模型覆盖（`tierOverrides`）；
2. 显式的单 provider 覆盖（`providerTiers`）；
3. 钉死的 provider 规则（`providerRules.<name>.pinTier`）；
4. **路由自带的价格标签**——很多 provider 会把当前费率拼进模型名
   （`Hy4 preview · x0.29 credits`），而会按时钟重算促销的 provider 显示的是
   *当前*费率，所以 `x0.00` 表示现在免费，其他数值表示要花钱；
5. provider 规则指定的价目表（`providerRules.<name>.price`）；
6. provider 自己的档位（`providerRules.<name>.tier`）；
7. 未知 provider 的默认档位（`defaultTierForUnknown`，默认 `paid`）。

第 4 条是 provider 无关的关键：名字里带价格的就按价格分层，不管是谁提供的。

### 内置默认规则

几个常见 provider 已预置，开箱即用。**它们只是默认值，不是策略**——你随时可以覆盖：

| Provider | 档位 | 说明 |
|---|---|---|
| `our-free-model` | 免费 | 免费通道，所有模型都不花钱 |
| `workbuddy` | 积分 | 免费与计费模型并存；档位跟随每个模型当前的价格 |
| `deepseek-account` | 积分 | 登录账号的余额 |
| `deepseek-official` | 付费 | API Key，按 token 计费 |
| 其他 | `defaultTierForUnknown` | 默认 `paid`，绝不把第三方 Key 当免费 |

## 每一档内部的顺序

档是外层顺序；档内的顺序取自 provider 自己的数据，保证**花最少的钱用最好的可用模型**：

- **免费档**——provider 自己 catalog 的顺序。数组顺序*就是*排名；排名表里没有的
  路由跟在有排名的后面。
- **积分档**——按当前价格，便宜的在前。看不到价格的模型排在所有有价格模型之后。
- **付费档**——没有公开价目，保持发现顺序。

### 分时段免费模型

有些模型只在某个时段免费（`夜间免费`、`限时免费`、`独家限免`、`夜间折扣`）。
catalog 里的 badge 是静态的，时段过了也还在，所以插件读的是**运行时显示名**——
provider 会按当前时钟重算它。时段内模型显示 `x0.00`，按免费处理；时段外则用
catalog 里保存的倍率作为它实际收取的价格。

## 配置

全部可选，零配置即可用。

```yaml
config:
  # 你的选择之后依次尝试的链。留空 = 自动发现。
  chain: []
  # "provider/model": "free" | "credits" | "paid"
  tierOverrides: {}
  # "provider": "free" | "credits" | "paid"
  providerTiers: {}
  # "provider": { tier, price, pinTier }
  providerRules: {}
  # 命名价目表："name": "~/path/to/catalog.json"
  priceCatalogs: {}
  # "provider/model": [...]
  excludeModels: []
  excludeProviders: []
  # 未知 provider 的档位。默认 "paid" 最安全。
  defaultTierForUnknown: paid
  # 跳过可用性探测标记为 region-blocked / unavailable 的路由。
  skipBlockedFreeModels: true
  # { "results": { "<model id>": { "state": ... } } }
  availabilityPath: ""
  # 免费档：优先用排名最高的模型。
  preferRanked: true
  # 积分档：优先用最便宜的模型。
  preferCheapestCredits: true
  # 排名 catalog。它的数组顺序就是排名。
  rankingCatalogPath: ""
  # 把每次决策写进这个文件。
  debugLog: ""
  # 表示"此路由不可用，换下一个"的失败码。
  escalateOn:
    - QUOTA
    - ACCOUNT_QUOTA
    - AUTH
    - NO_ADAPTER
    - INVALID_CREDENTIAL
    - MISSING_CREDENTIAL
    - CONTEXT_WINDOW_EXCEEDED
    - UNSUPPORTED_REASONING_EFFORT
  # 是否也对瞬态错误换模型。建议 false：那类交给 dsh-llm-retry 重试。
  escalateOnTransient: false
  # 永久兜底路由：永远排链尾，它失败即止（不再 retry）。留空则用链尾那个。
  fallback: { provider: "", model: "" }
  # 刚失败的路由在冷却期内不再被选，毫秒。0 = 关闭。
  cooldownMs: 60000
```

### 失败码

| 失败码 | 行为 |
|---|---|
| `QUOTA`、`ACCOUNT_QUOTA`、`AUTH`、`NO_ADAPTER`、`INVALID_CREDENTIAL`、`MISSING_CREDENTIAL`、`CONTEXT_WINDOW_EXCEEDED`、`UNSUPPORTED_REASONING_EFFORT` | 换到下一档 |
| `RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE` | 不换——交给 `dsh-llm-retry` 重试同一路由 |


### 短暂限流先重试，持续失败才换

`RATE_LIMIT` 同时是「可重试」和「应切换」：短时限流重试一下就好，长限流（比如「明天才恢复」）
重试再多也没用。插件用 `retriesBeforeSwitch`（默认 2）区分：同一条路由连续失败超过这个
次数就停止等待、直接换下一个。

```yaml
config:
  retriesBeforeSwitch: 2   # 0 = 第一次失败就换
```

`CLIENT_ERROR` / `INVALID_REQUEST` 这类「这个请求或这个模型不被接受」的错误会立即切换，不重试。

整条链跑完仍失败的步骤会以最后一个错误结束这一轮，与现在行为一致。不会死循环。

### 永久兜底（fallback）

不配置 `fallback` 时，链尾是分层排出来的最后一个（通常是最贵的付费档）。你可以**指定**一个兜底路由：

```yaml
config:
  fallback: { provider: "deepseek-official", model: "deepseek-flash" }
```

它的保证：

1. **永远排最后** —— 追加到链尾，即使它本来就在链里也会被移到最后
2. **失败即止** —— 它失败时不再返回 retry，让这一轮明确报错

这正是「链已经无能为力时，用你最信任的模型试最后一次，不行就如实说失败」，避免无限重试。

### 冷却（cooldownMs）

刚失败过的路由在冷却期内不会被再选，默认 60 秒：

```yaml
config:
  cooldownMs: 60000   # 0 = 关闭
```

这样同一条链连续走多次时，不会反复撞到同一个刚坏的模型。兜底路由不受冷却影响——它永远是最后那张牌。

## 调试日志

DSH 的 logger 写到宿主进程 stdout，被桌面 App 吞掉，所以你看不见为什么换/没换。
设置 `debugLog` 后，每次决策都会追加进该文件：发现的链、每个路由的档位查询、
每次失败的失败码、每次升级切换。

```yaml
config:
  debugLog: "~/.dsh/llm-failover.log"
```

## 说明

- failover 以 agent step 为粒度。直接调用 `ctx.llm.stream()` 的消费者仍是单次尝试，不受影响。
- 每次重试会在新路由上重新计费输入 token。
- 插件只读 provider 已经发布的数据，自己不联系任何服务。

## 许可

[MIT](./LICENSE)
