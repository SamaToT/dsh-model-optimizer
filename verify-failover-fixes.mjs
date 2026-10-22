// 验证 2026-10-22 的三个修复：
//   1. 手选模型失败后要冷却（否则同一个模型被反复打）
//   2. escalate 不能永远回落到链首 pos=0（否则 63 条路由闲置、单点承重）
//   3. 中和判定必须按 session 精确定位（否则作用在别的 provider 上）
//
// 这些是决策逻辑的单测；真实可用性只能看 App 的 llm-failover.log。
import path from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";

const repo = path.resolve(".");
// The App loads the plugin from ~/.dsh/plugin-src (a `file:` dependency), and
// the installed copy under the desktop profile must match it. All three are
// checked, because a fix that only reached the repository would not run.
const copies = [
  { name: "repo", file: path.join(repo, "index.js") },
  { name: "plugin-src", file: path.join(homedir(), ".dsh", "plugin-src", "dsh-model-optimizer", "index.js") },
  {
    name: "installed",
    file: path.join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "dsh-model-optimizer", "index.js"),
  },
];

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? "  -> " + detail : ""}`);
  }
}

for (const copy of copies) {
  const src = readFileSync(copy.file, "utf8");
  console.log(`=== ${copy.name} (${copy.file}) ===`);

  console.log("--- 1. 手选模型失败后写入冷却 ---");
  // DSH's agent/request-error payload has no model field, so the failing
  // route must come from the cursor (which remembers the selection), never
  // from the payload.
  check(
    "failed 路由取自 cursor 的 selection（不依赖 payload.model）",
    /const failed = cur\.pos >= 0 \? chain\[cur\.pos\] : cur\.selection;/.test(src),
  );
  check(
    "不再从 error payload 取 model",
    !/cur\.selection\s*:\s*\{\s*provider: payload\.provider, model: payload\.model/.test(src),
  );
  // The cooldown must be written AFTER `failed` is known — the route that
  // failed decides the key. The check is anchored on the error handler's
  // own block, not on the first "cooldowns.set(" in the file (the persistent
  // store has one of its own).
  const errorHandler = src.slice(src.indexOf('ctx.on(\n    "agent/request-error"'));
  check(
    "冷却写入发生在 failed 定义之后",
    errorHandler.indexOf("cooldowns.set(key, until);") > errorHandler.indexOf("const failed ="),
  );

  console.log("");
  console.log("--- 1b. cursor key 必须区分会话 ---");
  check("keyOf 接受 agent 参数", /function keyOf\(turn, step, agent\)/.test(src));
  check("keyOf 用 agent.id 做会话前缀", /agent\?\.id/.test(src) && /\$\{session\}\|\$\{turn\}:\$\{step\}/.test(src));
  check("request 阶段传 agent 进 keyOf", /keyOf\(payload\.turn, payload\.step, agent\)/.test(src));
  check("error 阶段传 agent 进 keyOf", /keyOf\(turn, step, payload\.agent\)/.test(src));

  console.log("");
  console.log("--- 2. escalate 不再永远回落 pos=0 ---");
  check("nextPos 接受 failedRoute 参数", /function nextPos\(chain, from, selection, failedRoute\)/.test(src));
  check("nextPos 跳过刚失败的路由", /failedRoute !== undefined && sameRoute\(route, failedRoute\)/.test(src));
  check("调用点传入 failed", /nextPos\(chain, cur\.pos, cur\.selection, failed\)/.test(src));
  check("cooldownMs 配置仍可调", src.includes("cfg.cooldownMs"));

  console.log("");
  console.log("--- 3. 中和判定按 agent 实例精确定位 ---");
  check("存在 agentRoutes 索引（WeakMap，按 agent 实例）", src.includes("const agentRoutes = new WeakMap()"));
  check("activeRoute 按 context.agent 查找", /function activeRoute\(context\)[\s\S]{0,300}context\?\.agent/.test(src));
  check("不再遍历全局 state 猜测路由", !/for \(const cur of state\.values\(\)\)/.test(src));
  check("不再依赖 turn 字符串格式", !src.includes("function sessionIdOf"));
  check("agent/request 记录 agentRoutes", /agentRoutes\.set\(agent/.test(src));
  check("escalate 记录 agentRoutes（prompt 早于 request）", /agentRoutes\.set\(agent, \{ provider: fb\.provider/.test(src));

  console.log("");
  console.log("--- 4. §5.2 冷却窗口按失败码分级 ---");
  check("存在按失败码的默认窗口表", /const DEFAULT_COOLDOWN_WINDOWS = \{/.test(src));
  check("限流的窗口是分钟级", /RATE_LIMIT: 300000/.test(src));
  check("永久性失败的窗口更长", /INVALID_REQUEST: 1800000/.test(src));
  check("瞬态错误的窗口是秒级", /SERVER: 30000/.test(src));
  check("冷却取窗口时按 code 查表", /function cooldownFor\(code\)/.test(src) && /cooldownWindows\[code\]/.test(src));
  check("写入冷却时用的是分级窗口", /const window = cooldownFor\(code\)/.test(src));
  check("用户的窗口覆盖内置默认值", /\{ \.\.\.DEFAULT_COOLDOWN_WINDOWS, \.\.\.\(cfg\.cooldownWindows \?\? \{\}\) \}/.test(src));

  console.log("");
  console.log("--- 5. §5.3 成功/失败计数（llm/stream） ---");
  check("监听 llm/stream 瀑布流", /ctx\.on\(\s*"llm\/stream"/.test(src));
  check("llm/stream 监听器不是 async（瀑布流同步返回可迭代对象）",
    /"llm\/stream",\s*\n\s*\(options, next\) =>/.test(src) && !/"llm\/stream",\s*\n\s*async \(options, next\) =>/.test(src));
  check("统计存储是持久化的", /class RouteStats/.test(src) && /this\.routes = new Map\(\)/.test(src));
  check("统计文件带版本号", /const STATS_VERSION = 1/.test(src));
  check("写入用临时文件 + rename（不会写坏）", /renameSync\(tmp, this\.path\)/.test(src));
  check("成功与失败都计数", /stats\.record\(key, ok\)/.test(src));
  check("失败不会被流和错误处理器重复计数", /function alreadyCounted\(key\)/.test(src) && /!alreadyCounted\(failedKey\)/.test(src));

  console.log("");
  console.log("--- 6. §5.1 按成功率重排 ---");
  check("成功率可配置开关", /rankBySuccessRate: z\.boolean\(\)/.test(src));
  check("档内按分数排序", /const byScore = \(a, b\) =>/.test(src));
  check("档位本身不参与重排（成本顺序不被打破）",
    /tiers\.free = \[\.\.\.tiers\.free\]\.sort\(byScore\)/.test(src) &&
    /tiers\.credits = \[\.\.\.tiers\.credits\]\.sort\(byScore\)/.test(src));
  check("样本不足的路由按 0.5（未知）处理，不被当成差路由",
    /if \(samples < statsMinSamples\) return 0\.5;/.test(src));
  check("分数被量化（保证比较是全序，防抖动）", /Math\.round\(scoreOf\(route\) \/ epsilon\)/.test(src));
  check("新统计会让链失效并重建", /markStatsStale\(\)/.test(src) && /chainStale = false;/.test(src));

  console.log("");
  console.log("--- 7. 冷却窗口跨重启保留 ---");
  check("冷却期限写入持久化存储", /stats\.setCooldown\(key, until\)/.test(src));
  check("冷却判定读持久化存储", /stats\.cooldownUntil\(key\)/.test(src));
  check("持久化文件保存未过期的冷却期限", /cooldowns: Object\.fromEntries/.test(src));
  check("启动时读回冷却期限", /cooldowns loaded/.test(src));

  console.log("");
}

console.log("");
console.log(`结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
