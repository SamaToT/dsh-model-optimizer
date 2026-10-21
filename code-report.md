# DSH 生态错误码全表

采集自：`dsh-llm` 核心、`dsh-llm-pi-ai`（workbuddy 走这条）、`dsh-our-free-model`、`dsh-llm-deepseek`

## 一、按来源

### dsh-llm 核心（`LlmError` 抛出）

| 错误码 | 含义 | 能否换模型解决 |
|---|---|---|
| `QUOTA` | 上游额度耗尽 | ✅ 能 |
| `ACCOUNT_QUOTA` | 账号余额不足 | ✅ 能 |
| `CONTEXT_WINDOW_EXCEEDED` | 超上下文窗口 | ✅ 能（换大窗口模型） |
| `INVALID_CREDENTIAL` | 凭据无效 | ✅ 能（换个 provider） |
| `NO_ADAPTER` | 该 provider 未注册 | ✅ 能 |
| `UNSUPPORTED_REASONING_EFFORT` | 模型不支持该推理档 | ✅ 能 |
| `RATE_LIMIT` | 限流 | ⚠️ 看时长 |
| `SERVER` | 上游 5xx | ⚠️ 看情况 |
| `TIMEOUT` | 超时 | ⚠️ 看情况 |
| `TRANSPORT` | 网络/连接错误 | ⚠️ 看情况 |
| `EMPTY_RESPONSE` | 空响应 | ⚠️ 看情况 |
| `AUTH` | 鉴权失败 | ✅ 能 |
| `MISSING_CREDENTIAL` | 缺凭据 | ✅ 能 |
| `ABORTED` | 调用方取消 | ❌ 不能（用户主动取消） |
| `IMAGE_OFFLOAD_REQUIRED` | 需先卸图片 | ✅ 能（换支持图片的模型） |
| `DUPLICATE_ADAPTER` | 重复注册 adapter | ❌ 不能（配置问题） |
| `INVALID_ADAPTER` | adapter 元数据非法 | ❌ 不能（代码问题） |
| `INVALID_CATALOG` | 模型目录非法 | ❌ 不能（adapter bug） |
| `INVALID_MODEL_INFO` / `_CONTEXT` / `_MAX_TOKENS` / `_REASONING` | 模型元数据非法 | ❌ 不能（adapter bug） |
| `INVALID_PREPARED_CALL` | prepareCall 返回非法 | ❌ 不能（代码问题） |
| `INVALID_DIRECTORY` / `DUPLICATE_DIRECTORY` / `NO_DISCOVERY` / `INVALID_DISCOVERY` / `DUPLICATE_DISCOVERY` | provider 目录/发现注册问题 | ❌ 不能（配置问题） |
| `REGISTRATION_DISPOSED` | 注册已释放 | ❌ 不能（生命周期问题） |

### dsh-llm-pi-ai（workbuddy 走这条）

pi-ai 会把上游错误按 HTTP 状态/文本分类成：

| 上游情况 | 映射到 | 能否换模型解决 |
|---|---|---|
| 401 / 403 | `AUTH` | ✅ |
| 429 / rate limit | `RATE_LIMIT` | ⚠️ |
| 413 / payload too large | `INVALID_REQUEST` | ✅ |
| 400 / invalid request | `INVALID_REQUEST` | ✅ |
| 5xx | `SERVER` | ⚠️ |
| timeout | `TIMEOUT` | ⚠️ |
| stream ended before | `TRANSPORT` | ⚠️ |
| network / ECONN* / socket | `TRANSPORT` | ⚠️ |
| 缺 apiKeyEnv | `MISSING_CREDENTIAL` | ✅ |
| 调用方取消 | `ABORTED` | ❌ |
| 其他 | `PI_AI_ERROR` | 未知 |

### dsh-our-free-model

| 内部代号 | 映射到 | 能否换模型解决 |
|---|---|---|
| region | `REGION_BLOCKED` | ✅（换非区域限制的模型） |
| quota | `RATE_LIMIT` | ⚠️ |
| credential | `INVALID_CREDENTIAL` | ✅ |
| authorization | `AUTHORIZATION_REQUIRED` | ✅（换别的 provider） |
| transport | `TRANSPORT` | ⚠️ |
| timeout | `TIMEOUT` | ⚠️ |
| server | `SERVER` | ⚠️ |
| client | `CLIENT_ERROR` | ✅ |
| empty | `EMPTY_RESPONSE` | ⚠️ |
| aborted | `ABORTED` | ❌ |

### dsh-workbuddy-connect

workbuddy 不产生自己的 DSH 码，它把上游错误交给 pi-ai 分类（见上）。但它有一个**特殊行为**：上游返回的 429 文案里带了具体重置时间，pi-ai 只能看到 `RATE_LIMIT`，**看不到"要等到明天"这个信息**——这正是我之前 `RATE_LIMIT` 不切换的坑。

---

## 二、当前插件覆盖情况

### 已覆盖（12 个）

`QUOTA`、`ACCOUNT_QUOTA`、`AUTH`、`NO_ADAPTER`、`INVALID_CREDENTIAL`、`MISSING_CREDENTIAL`、`CONTEXT_WINDOW_EXCEEDED`、`UNSUPPORTED_REASONING_EFFORT`、`CLIENT_ERROR`、`INVALID_REQUEST`、`INVALID_MODEL_REASONING`、`RATE_LIMIT`

### 应该补上（能换模型解决但没覆盖）

| 错误码 | 来源 | 理由 |
|---|---|---|
| `REGION_BLOCKED` | OFM | 区域限制，换个不受限的模型就行 |
| `AUTHORIZATION_REQUIRED` | OFM | 该渠道未授权，换别的 provider |
| `IMAGE_OFFLOAD_REQUIRED` | dsh-llm | 模型不支持图片，换支持图片的模型 |
| `PI_AI_ERROR` | pi-ai | 未知上游错误，换模型可能好 |

### 刻意不覆盖（换模型也解决不了）

| 错误码 | 理由 |
|---|---|
| `ABORTED` | 用户主动取消，换模型是错的 |
| `DUPLICATE_ADAPTER`、`INVALID_ADAPTER`、`INVALID_CATALOG`、`INVALID_MODEL_*`、`INVALID_PREPARED_CALL` | adapter 代码 bug，换模型掩盖问题 |
| `INVALID_DIRECTORY`、`NO_DISCOVERY`、`INVALID_DISCOVERY`、`REGISTRATION_DISPOSED` | 配置/生命周期问题 |
| `SERVER`、`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE` | 瞬态，交给 `dsh-llm-retry` 重试（`escalateOnTransient` 可开） |

---

## 三、结论

1. **核心能换模型解决的码只有 4 个没覆盖**：`REGION_BLOCKED`、`AUTHORIZATION_REQUIRED`、`IMAGE_OFFLOAD_REQUIRED`、`PI_AI_ERROR`
2. **`RATE_LIMIT` 需要"连续失败几次才切"**（已实现 `retriesBeforeSwitch`），因为 pi-ai 看不到上游的重置时间
3. 其余 21 个未覆盖的码，**要么换模型解决不了，要么是瞬态应当重试**——不覆盖是正确的

建议：补齐这 4 个，攒到下一个版本发。
