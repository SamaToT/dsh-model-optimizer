# dsh-model-optimizer 交接文档

> 写给下一个会话（建议在 **创造模式 / `cordis` preset** 下阅读）。
> 全部内容来自 2026-10-22 一整天的实读源码与真实 App 日志，不是推测。
> 每条结论都标注了证据来源。

---

## 1. 这个插件是什么

`dsh-model-optimizer`（npm 名），插件名 `llm-failover`。
DSH（DeepSeek Harness）的**成本分层自动模型切换**插件：所选模型无法完成请求时，
沿「免费 → 积分 → 付费」的成本链换模型重跑该步。

### 代码的三份副本（必须一致）

| 路径 | 角色 |
|---|---|
| `C:\Users\Administrator\Documents\deepseek-harness\default-workspace\dsh-model-optimizer` | **git 仓库**（GitHub: `SamaToT/dsh-model-optimizer`） |
| `C:\Users\Administrator\.dsh\plugin-src\dsh-model-optimizer` | **App 实际加载的源**（`package.json` 里 `file:../../plugin-src/dsh-model-optimizer`） |
| `C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-model-optimizer` | pnpm 安装的**拷贝**（不是 symlink） |

> **踩过的坑**：只改仓库那份 → App 跑的还是旧代码。
> 改完必须同步三处：`copy index.js` 到后两个 + 各自 `package.json` 的 version。

### 配置位置

`C:\Users\Administrator\.dsh\profiles\desktop\cordis.patch.yml`：

```yaml
- id: llm-failover
  name: dsh-model-optimizer
  config:
    debugLog: ~/.dsh/llm-failover.log
    retriesBeforeSwitch: 2
    neutralizeIdentityFor:
      - workbuddy
    cooldownMs: 30000
    escalateOn: [ ...17 个失败码... ]
```

### 运行时证据

- `C:\Users\Administrator\.dsh\llm-failover.log` —— 每次决策一行（`request` / `request-error` / `escalate pos=N` / `cooldown` / `neutralized` / `chain free=N`）
- `C:\Users\Administrator\.dsh\freeroute\freeroute.log` —— 另一个插件 freeroute 的日志

---

## 2. DSH 的真实 hook 契约（实读 `app.asar` 源码得到）

> `app.asar` 是压缩包，shell 打不开。提取脚本见 §6。

### 2.1 三个 waterfall 的 payload

`@deepseek-ai/dsh-agent` 的 `agentEvents(ctx, agent)` 把 **agent 实例融合进每个 `agent/*` payload**：

```js
const fused = (payload) => ({ ...payload, agent });
```

| 事件 | payload | 关键点 |
|---|---|---|
| `agent/request` | `{ turn, step, signal, agent }` | `turn` 是**数字计数器** |
| `agent/request-error` | `{ turn, step, provider, failure, retryPolicy, signal, agent }` | **`agent` 在这里** |
| `system-prompt/assemble` | `(assembly, context, next)`，`context = { agent, scope: agent, signal }` | `context.agent` 与上面**同一个对象** |

`@deepseek-ai/dsh-agent-loop`：`assembleContextFor(agent, signal)` → `{ agent, scope: agent, signal }`。

### 2.2 两个必须记住的坑

**坑 1：`turn` 是数字，不是 session 字符串。**
`agent-loop` 里 `phase.turn + 1`、`lastTurn ?? 0`。日志里 2709 次里有 38 次带
`session-xxx|N` 前缀（另一条入口路径），**2671 次是纯数字**。
⇒ **不能靠解析 turn 字符串拿 session id**。

**坑 2：`agent.options` 是静态的，failover 不会改它。**
`agent-loop` 里 `route = { provider: this.options.provider, model: this.options.model }`。
DSH 官方渲染 `{{provider}}` 变量用的就是 `context.agent.options.provider`
（`al.js:1591`）——**failover 之后它就是错的**，这正是本插件要自己维护「当前实际路由」的原因。

**因此**：agent 实例（`payload.agent` / `context.agent`）是唯一能把
「请求阶段决定的路由」和「提示词组装阶段」精确关联起来的钥匙。
用 `WeakMap<agent, {provider, model}>`。

### 2.3 agent.id 的含义

`agent-loop` 的 `create(id, options, meta)` → `ctx.sessions.prepare(id, ...)`，
所以 **agent.id === session id**。但 `this.id` 不适合做 Map key（字符串），用对象本身更好。

---

## 3. 真实数据（`llm-failover.log`，2026-10-20 ~ 10-22）

### 3.1 按 (provider, model) 统计 —— 必须用 step 号回关

error 行里**没有 model 字段**，得用 `request-error step=...` 的 step 号
回关到同一 step 的 `request step=...` 行才能得到 model。

```
 38 次  workbuddy/step-5-preview                          [RATE_LIMIT]
 18 次  our-free-model/nvidia/nemotron-3.5-super-vl:free  [SERVER]
 17 次  workbuddy/hy3                                     [INVALID_REQUEST]
  9 次  workbuddy/hy3                                     [RATE_LIMIT]
  8 次  deepseek-account/deepseek-flash                   [ACCOUNT_QUOTA]
  7 次  workbuddy/step-5-preview                          [INVALID_REQUEST]
```

**请求次数：**

```
384  our-free-model/minimax/minimax-m3.1-flash:free     ← 失败率 0%
329  workbuddy/hy3                                      ← 8%
280  workbuddy/step-5-preview                           ← 16%
200  our-free-model/kilo-auto/free                      ← 2.5%
191  our-free-model/nvidia/nemotron-3.5-super-vl:free   ← 9%
 64  workbuddy/deepseek-v4.1-flash
 46  our-free-model/reflection/beam-free
 38  deepseek-account/deepseek-flash
 27  freeroute/auto
 23  workbuddy/hy3-x
  2  workbuddy/hy4-preview
  1  our-free-model/mimo-v2.6-flash-free
```

### 3.2 关键结论

**链内 75 条路由，只有 12 条被真实请求过 —— 84% 一次没碰。**

**六个 escalate 全部是 `pos=0`**，即每次失败都回落到链首同一个模型。

**原因（v1.5.0 已修的三个缺陷）**：

1. **手选模型失败从不冷却**
   `const failed = cur.pos >= 0 ? chain[cur.pos] : undefined;`
   → 手选失败时 `failed` 是 `undefined` → 不写冷却 → 下个 step 又打同一条。
2. **`nextPos` 从链首扫**
   手选失败时 `from = -1` → `for (pos = from + 1; ...)` 从 0 开始 → 永远命中链首。
   两个 bug 叠加 = 死循环在同一个模型上。
3. **中和判定取错了路由**
   `activeRoute()` 遍历 `state.values()` 取**第一条** `pos >= 0` 的记录。
   多会话时那是**别的会话**的路由 → `neutralizeIdentityFor` 作用在错的 provider 上
   → workbuddy 的签名照旧被拒（`INVALID_REQUEST`）。

### 3.3 workbuddy 上游的时间线（重要背景）

| 日期 | workbuddy 请求 | 错误 | 说明 |
|---|---|---|---|
| 10-20 | 540 | 45（43 RATE_LIMIT + 1 INVALID_REQUEST） | **上游还没开始校验签名** |
| 10-21 | 23 | 21（18 INVALID_REQUEST） | **上游 10-20 末/10-21 开始校验签名** |
| 10-22 | 26 | 1 | 方案 C 生效后基本干净 |

⇒ 「之前能连上」= 上游当时不查签名；「现在连不上」= 上游查了，需要中和。
**workbuddy 插件 0.7.9 本身没有中和能力**（三个 `prepare*` 函数只要看到已有 system 就原样返回；
grep `REJECTED_SYSTEM_SIGNATURES` / `You are an AI agent` 全空）。
中和是本插件的 `neutralizeIdentityFor` 做的。

---

## 4. v1.5.0 已修什么（commit 7faf717，tag v1.5.0）

1. `failed` 路由对**手选模型**也构造 → 冷却生效。
2. `nextPos(chain, from, selection, failedRoute)`：跳过刚失败的路由，**沿链前进**而不是回链首。
3. `activeRoute(context)` 改用 `WeakMap<agent, route>`（`agentRoutes`）精确关联；
   `escalate` 时也写 `agentRoutes`（**提示词组装早于请求**，只在下一次 request 写会慢一拍）。

**修复后的真实日志（真 cordis 环境）：**

```
cooldown our-free-model/kilo-auto/free for 30000ms
escalate pos=1 -> our-free-model/minimax/minimax-m3.1-flash:free
cooldown our-free-model/minimax/minimax-m3.1-flash:free for 30000ms
escalate pos=2 -> workbuddy/hy3
```

（修复前每次都是 `pos=0`。）

---

## 5. 还没解决的问题（下一版该做的）

### 5.1 链序不看实际成功率 —— 最大的问题

链序规则只有「免费→积分→付费」+ 价格标签（`loadRanking` 读
`~/.dsh/our-free-model/catalog.json`，`loadPriceCatalog` 读 workbuddy 写的价目文件）。
**成功率完全没进排序。**

实测：`minimax/m3.1-flash:free` 384 次 0 失败，却排在
`kilo-auto/free`（200 次 5 失败）**后面**。

### 5.2 冷却窗口一刀切

`cooldownMs: 30000` 对所有错误码一样。但：
- `RATE_LIMIT`：额度窗口是**分钟级**，30 秒后重打必然再撞
- `INVALID_REQUEST`（签名被拒）：**永久性**，30 秒毫无意义
- `SERVER`：30 秒合理

⇒ 需要**按失败码分级**的冷却窗口。

### 5.3 插件不记成功历史

384 次成功和 191 次被限流的路由在插件眼里等价。要做成功率排序，
必须先有**持久化的成功/失败计数**。

### 5.4 escalate 粒度太粗

一次失败就换模型 = 丢弃已生成的 token。
freeroute 那种「首个 token 到达前就切」的设计本插件没有。
（这条要动 DSH 内部，风险高，建议放到最后考虑。）

### 5.5 建议的下一版范围

- **v1.6.0**：分级冷却窗口 + 成功/失败计数 + 统计持久化（数据积累期）
- **v1.6.1**：用积累的统计数据做成功率加权排序（注意排序抖动、跨会话持久化）
- 验收标准必须是**真实 App 日志**，不是 mock

---

## 6. 验证方法（这套是有效的，别再走 mock）

### 6.1 从 app.asar 提取 DSH 官方包

`app.asar` 是 asar 格式，需要自己解析 header：

```js
const fs = require('fs');
const p = 'D:/工具/DeepSeek Harness/resources/app.asar';
const fd = fs.openSync(p, 'r');
const b = Buffer.alloc(16); fs.readSync(fd, b, 0, 16, 0);
const headerPickleSize = b.readUInt32LE(4);
const hb = Buffer.alloc(headerPickleSize); fs.readSync(fd, hb, 0, headerPickleSize, 8);
const jsonLen = hb.readUInt32LE(4);
const hdr = JSON.parse(hb.slice(8, 8 + jsonLen).toString('utf8'));
const dataOffset = 8 + headerPickleSize;
// 按路径逐段走 hdr.files[node]，取 { size, offset }，
// 再 fs.readSync(fd, buf, 0, size, dataOffset + Number(offset))
```

要读的包：
- `dsh/node_modules/@deepseek-ai/cordis/lib/index.js`（v4.0.5）
- `dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js`（`agentEvents` / `assembleContextFor`）
- `dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js`（`prepareRequest` / `preStep` / turn 的来源）

### 6.2 真 cordis 测试环境

```
%LOCALAPPDATA%\Temp\cordis-real\
  node_modules\@deepseek-ai\cordis\{package.json, lib\index.js}   ← 从 asar 提取
  node_modules\@deepseek-ai\cosmokit   ← junction 软链到 profile 的
  node_modules\@deepseek-ai\schemastery ← 同上
  plugin-index.js   ← 插件副本（放在这里才能解析到 schemastery）
  verify.mjs        ← 测试
```

**cordis v4 的 API**（和 v3 不同）：

```js
import { Context } from "@deepseek-ai/cordis";
const ctx = new Context();
ctx.provide("llm", fakeLlm);          // 注入假 llm 服务
await ctx.plugin(plugin, config);     // 启动插件，cordis 会调 plugin.apply(ctx, config)
// 注意：没有 ctx.start()，没有 ctx.stop()，结束用 await ctx.fiber.dispose()
```

**踩过的坑**：
- `ctx.emit(...)` **不返回 waterfall 结果**（返回 undefined）→ 断言要靠插件的 `debugLog` 捕获
- Windows 上 `import()` 绝对路径必须用 `pathToFileURL(p).href`
- 插件里 `import z from "@deepseek-ai/schemastery"` → 插件副本必须放在有 `node_modules` 的目录
- 假 llm 只需三个方法：`listProviders()` / `listModels(provider)` / `resolveModelInfo(provider, model)`

### 6.3 现有测试

| 文件 | 作用 | 状态 |
|---|---|---|
| `verify-identity.mjs` | identity 中和（mock waterfall） | 7/7 |
| `verify-failover-fixes.mjs` | 三个修复的源码断言（读三份副本） | 36/36 |
| `verify-cordis-real.mjs` | **真 cordis v4 + 真插件 + 真 waterfall** | 9/9 |

真实 cordis 那个测试需要把插件和测试脚本复制到 `%TEMP%\cordis-real\` 再跑
（因为插件要从自己的目录解析 schemastery）。

### 6.4 用户路径的最终证据

只有 `~/.dsh/llm-failover.log` 里的 `request` / `request-error` 行
（App 真实请求留下的）能证明「某个 provider 能不能用」。
注入式探测只能证明决策逻辑。

---

## 7. 环境坑（别再犯）

| 坑 | 说明 |
|---|---|
| **绝不 kill App 的 DSH 宿主** | 命令行含 `--expose-internals ...dsh-desktop-host/lib/index.js`，父进程 = App 主进程。杀了它 → App 重启 → `dsh-web-app.openBrowser()` 弹 `http://127.0.0.1:3080/` → 无限弹窗。**只有 `lib/cli.js --profile X` 才是可以杀的验证进程** |
| **验证进程要加 `--no-open`** | 否则每次起 DSH 都开浏览器（`dsh-web-app` 的 `openBrowser` 默认 true） |
| **本机没有 pnpm/npm 在 PATH** | 装插件用 `npm pack <pkg> --pack-destination` 取 tarball → `tar -xzf ... --strip-components=1` 解到 `node_modules/`。不要用 `pnpm install`（会卡住） |
| **desktop profile 由 App 管理** | `dsh plugin add --profile desktop` 会被拒。改 `package.json` 的 `dsh.profile.bundles` + `dependencies`，再装包 |
| **改完要重启 App 才生效** | 但**不要替用户重启**（那是 3080 事故的起因） |
| **`cordis.patch.yml` 用 edit 精确改** | 绝不 write 整体覆盖（2026-10-21 事故的直接原因：凭记忆重写把 workbuddy 的 insert 条目整条弄丢） |

---

## 8. Git 状态

- 远程：`https://github.com/SamaToT/dsh-model-optimizer.git`
- 分支：`main`，最新 tag **v1.5.0**（commit `7faf717`）
- 发布纪律：**攒够实质性改动再打 tag**，不要每个修复都发；只有致命 bug 立刻发。
- 每版发布前必须：`README.md` + `README.en.md` 同步更新、版本号三处同步、测试全绿。

---

## 9. 用户偏好（改这个插件时务必遵守）

1. **别让他当测试员**——自己起真实进程、自己验、改到「重启一次就好」的状态。
2. **先查自己**——结构性异常（provider 不出现、配置不生效、bundle 不加载）先怀疑自己的安装/配置链。
3. **搜得出来就别硬扛**——不要用「我没权限/文档没写/不知道」当挡箭牌。
4. **没验证不要说「修好了」**——必须附刚跑出的真实输出。
5. **不接受同一句话反复说**——绕圈立刻换方法。
6. **结构化文件只经其所有者工具改**——`cordis.patch.yml` / `package.json` 用 edit 精确替换，改完 read 回来核对。
