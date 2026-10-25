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

### 3.3 workbuddy 上游的时间线与真正的根因

| 日期 | workbuddy 请求 | 错误 | 说明 |
|---|---|---|---|
| 10-20 | 540 | 45（43 RATE_LIMIT + 1 INVALID_REQUEST） | 上游当时还没开始渠道校验 |
| 10-21 | 23 | 21（18 INVALID_REQUEST） | 上游 10-20 末/10-21 开始校验 |
| 10-22 | 26 | 1 | 仍未解决（根因见下） |

**2026-10-22 晚，实测确定的真正根因**（对照实验，见 §4.1）：

workbuddy 走的是 **CN 变体**（`status` 显示 `domain: www.codebuddy.cn`，
端点 `CN_CHAT_BASE = https://copilot.tencent.com`）。CN 上游的渠道校验有
**两个必要条件**，缺一即被拒（HTTP 400 / code 11128）：

1. 第一条 system 消息的**开头**不能是 rival 身份签名
   （`You are an AI agent powered by DeepSeek Harness.`）
2. system 消息的 **role 必须是 `system`**——pi-ai 对 reasoning 模型发
   `role: "developer"`，因为 `detectCompat` 对这个 baseUrl 判定
   `supportsDeveloperRole: true`（`isNonStandard` 不含它、`isOpenRouter` 为 false）

**官方 `dsh-workbuddy-connect` 0.7.9 只在国际版路径修这两件事**
（`prepareChatBody`，`region === "global"` 时才走）；**CN 路径
（`prepareCnChatBody`）两件都没做**，所以 DSH 的每一个 workbuddy 请求都被拒。
停维护的 `lin666hub/dsh-workbuddy-connect-fixed` 同样漏了 CN 路径。
npm 上 0.7.9 已是最新版，没有修复。

**⇒ 本插件的 `neutralizeIdentityFor` 解决不了这个问题**，它改的是
`harness:identity` **那一段**的文字，而上游检查的是**整条 system 消息的开头**；
而且它无法处理 role 这一半。该功能已从 profile 配置中移除。

**真正的修复在另一个插件**：`dsh-workbuddy-cn-fix`
（`~/.dsh/plugin-src/dsh-workbuddy-cn-fix`，GitHub `SamaToT/dsh-workbuddy-cn-fix`），
见 §4.1。


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

### 4.1 v1.6.0 修好的（commit 见 §8，tag v1.6.0）

1. **§5.2 冷却窗口按失败码分级**（`DEFAULT_COOLDOWN_WINDOWS`）。
2. **§5.3 成功/失败计数 + 持久化**（`llm/stream` 计数 → `~/.dsh/llm-failover-stats.json`）。
3. **§5.1 链序按实测成功率加权**（档内重排，三条防抖规则）。
4. **冷却窗口跨重启保留**（§5.6，真环境跑出来的 bug）。

---

## 5. v1.7.0 做了什么（§5.4 已实现，§5.7 已修）

### 5.4 穷举整条链，直到全部不可用才报错 ✅

**用户原话**：「策略性选择模型，穷举所有模型，直到所有都不能用为止才报错」。

之前的语义是「试到兜底路由为止，兜底失败就报错」——但**兜底路由只是链尾那个**，
链上其它路由根本没被尝试过。v1.7.0 改成：

- 每次 escalate 时沿链前进，**不回链首**（`turnCursor` 按 `session|turn:<n>` 跨 step 记录位置）。
- **冷却的路由在当前 step 被跳过**，但下一个 step 会重新纳入（冷却不是永久剔除）。
- 只有当**整条链上每一个路由都处于冷却中**时，才让这一轮以错误结束。
- 插件**自己 owning `agent/request-error`**，不让 `dsh-llm-retry` 的 `llm/retry` 事件
  撞上非序列化 payload（那个是 2026-10-21 「处理失败」崩溃的真因）。

**验证**：`.probe/verify-exhaust.mjs`（5/5 模型全试，turn 以真实 error 结束）、
`.probe/verify-no-llm-remit.mjs`（加载真实 `dsh-llm-retry`，0 个 `llm/retry` 事件）。

### 5.7 链构建竞态 ✅

真环境日志里出现过 `chain free=8` 和 `chain free=26` 交替——`buildChain()` 在 provider
还在枚举模型时就把残缺的链缓存了。v1.7.0 加了**链就绪标记**，未就绪时不使用缓存链。

> §5.4 的「首个 token 前就切」粒度仍未做：那要动 DSH 内部，风险高。

### 5.1 链序按实测成功率加权 ✅

`llm/stream` 瀑布流记下每条路由的成败，链在**档内**按成功率重排。三条防抖规则：

1. **档位本身不动**（free 永远在 credits 前）——成本顺序不被成功率打乱；
2. **样本不足 = 未知，不是差**——按先验均值 0.5 计分，不因没数据被提到前面，
   也不因别人失败被踢到最后；
3. **分数量化到 `statsRankEpsilon`（默认 0.02）**——同一档内保持原相对顺序，
   链不会每记一次结果就重排一次。

> **踩过的坑（已修）**：第一版给「未知路由」打了 `prior * 0.5 = 4.0` 分，
> 而实测成功率在 [0,1]，于是**每条没试过的路由都跳到链首**。
> 先验的**权重**（8）和先验的**均值**（0.5）不是一回事。

### 5.2 冷却窗口按失败码分级 ✅

`DEFAULT_COOLDOWN_WINDOWS` 按「这个故障要持续多久」分级：
限流 5 分钟 / 永久性失败 30 分钟 / 服务端抖动 30 秒。
`cooldownWindows` 配置项可以覆盖其中任意几个码，其余仍走 `cooldownMs`。

### 5.3 成功/失败计数 + 持久化 ✅

- 计数点选在 `llm/stream`（**唯一能看到成功的地方**），不是
  `agent/request-error`（只看得到失败）。
- 存储：`~/.dsh/llm-failover-stats.json`，临时文件 + rename 写入，不会写坏。
- 累计计数 `ok`/`bad` + 最近 `statsWindow` 条结果的位串（滑窗成功率）。
- **失败去重**：一次失败会被 `llm/stream` 的终止 chunk 和 `agent/request-error`
  各报一次，两处都计会让失败率虚高。用一个 5 秒的标记保证只计一次。

### 5.6 顺带修掉的真 bug：冷却窗口跨重启丢失 ✅

**这是真实环境跑出来的，不是想出来的。**

原来的冷却表在内存里，**每次进程重启就没了**。而 §5.2 把窗口拉长到
分钟级之后，这恰好是最不能丢的东西——App 经常重启。

真环境证据（`~/.dsh/llm-failover-verify5.log`，5 个独立进程）：

```
routes re-picked inside their own cooldown window: 11
```

即：一个被判定「30 分钟内不要再碰」的路由，在**下一个进程**又被选了 11 次。

修法：冷却期限和统计一起持久化（`stats.setCooldown` / `stats.cooldownUntil`），
启动时读回。修完后真环境日志里每个进程开头都有：

```
cooldowns loaded 8 from C:\Users\Administrator\.dsh\llm-failover-stats-verify5.json
```

### 5.7 下一个版本该做的

- **§5.4 escalate 粒度**（首个 token 前就切）——要动 DSH 内部，风险高。
- **链构建竞态**：真环境日志里出现过 `chain free=8` 和 `chain free=26` 交替，
  说明 `buildChain()` 在 provider 还在枚举模型时就把**残缺的链**缓存了。
  需要在链构建时等 provider 的模型列表稳定，或给残缺的链加标记。
  （这一条不修，成功率排序偶尔会用一条短的链算。）

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
| `verify-failover-fixes.mjs` | 源码断言（读三份副本），含 §5 各项 | 123/123 |
| `verify-cordis-real.mjs` | **真 cordis v4 + 真插件 + 真 waterfall** | 17/17 |

真实 cordis 那个测试需要把插件和测试脚本复制到 `%TEMP%\cordis-real\` 再跑
（因为插件要从自己的目录解析 schemastery）。

**`verify-cordis-real.mjs` 的两个关键写法**（别改回去）：

1. **用 `ctx.events.waterfall(ctx, name, payload, inner)`，不要用 `ctx.emit()`。**
   `ctx.emit` 不返回 waterfall 的结果，也不把 `next` 传给监听器——
   插件的处理器里 `next()` 会是 undefined。
2. **假 llm 的 `listModels()` 必须返回对象数组**（`{ id, name }`），不是字符串数组。
   返回字符串的话插件一条路由都发现不了，测试会对着一条**空链**断言，
   然后「通过」——这种假绿比失败更糟。

### 6.4 真 DSH 进程验证（比 mock 强一档）

`desktop` profile 由 App 管理，CLI 拒绝启动它
（`error: profile "desktop" is managed exclusively by the Electron application`）。
但**可以另建一个 profile** 来跑真的 DSH 进程：

```sh
# 从 asar 取出 CLI
node extract.mjs <out> dsh/node_modules        # 取出 @deepseek-ai/dsh 等
cd <out>/dsh/node_modules/@deepseek-ai/dsh
HOME="$USERPROFILE" USERPROFILE="$USERPROFILE" \
  node lib/bin.js --profile verify-5 headless "Reply with exactly the word: PONG"
```

`verify-5` profile 的做法（`.probe/make-profile.mjs`）：

- `node_modules` 从 desktop profile **整份复制**（真的 provider + 真的凭据）；
- `cordis.patch.yml` 从 desktop profile 复制，只改插件的 `debugLog` / `statsPath`，
  并删掉 `ui-*` 那几行（Web bundle 没挂载，留着会加载失败）；
- `package.json` 的 `dsh.profile.bundles` 只留
  `dsh-base` / `dsh-headless` / `dsh-model-optimizer` / `dsh-our-free-model` /
  `dsh-workbuddy-connect` / `dsh-freeroute`；
  **不挂 `dsh-web-app`**（它启动时会开浏览器 = 3080 弹窗事故）。

`headless` bundle 本身会 **disable `credentials` 和 `deepseek-account`**，
所以它只能靠启动时的环境变量凭据；想用账号里的 provider，
就得像上面这样自己拼一个 profile（不 disable 凭据插件）。

### 6.5 用户路径的最终证据

只有 `~/.dsh/llm-failover.log` 里的 `request` / `request-error` / `outcome` 行
（App 真实请求留下的）能证明「某个 provider 能不能用」。
注入式探测只能证明决策逻辑。

v1.6.0 起，App 自己的日志里会有这些行（真实 App 请求留下的）：

```
2026-10-22T07:25:27.540Z outcome ok freeroute/auto (tool-calls) total ok=1 bad=1
2026-10-22T07:39:51.807Z request-error step=214:9 provider=freeroute code=STREAM_CLOSED dead=false transient=false
2026-10-22T07:26:19.743Z cooldown our-free-model/mimo-v2.6-flash-free for 1800000ms (INVALID_CREDENTIAL)
```

`outcome` 的 kind 有三种：`stop`（正常结束）、`tool-calls`（模型要调工具）、
`error`（失败）。**`tool-calls` 算成功**——模型正常跑完了这一轮。

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
| **三份副本是硬链接** | `~/.dsh/plugin-src/dsh-model-optimizer` 和 profile 的 `node_modules/dsh-model-optimizer` 是**同一个 inode**（nlink=2），仓库那份是独立的。同步要**原地覆写**（truncate+write），删了重建会断链，profile 那份会停在旧内容上——看起来就像「装上了但没生效」 |
| **`install_bundle` 对已装的 `file:` 包报 `already-installed`** | 这是正常的：这个包是 profile 的 `file:` 依赖，内容本来就在原地生效。`remove_bundle` 再装会把 `file:` 依赖从 profile 里摘掉，比"没报错"更糟 |
| **App 会热加载插件代码** | 改完 `node_modules` 里的 index.js，**不用重启 App** 就生效了。v1.6.0 上线后 App 自己的 `~/.dsh/llm-failover.log` 立刻开始写 `outcome` 行 |
| **真 DSH 进程要设 `HOME`/`USERPROFILE`** | 不设会报 `无法解析 HOME/USERPROFILE 或 DSH_HOME（launchEnvironment 缺失）` |
| **`dsh-headless` 不在 desktop profile 里** | 它要单独从 asar 复制进验证 profile 的 `node_modules/@deepseek-ai/` |

---

## 8. Git 状态

- 远程：`https://github.com/SamaToT/dsh-model-optimizer.git`
- 分支：`main`，最新 tag **v1.6.0**（本会话）
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
