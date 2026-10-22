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
  const failedDecl = src.match(
    /const failed\s*=\s*\n?\s*cur\.pos >= 0 \? chain\[cur\.pos\] : \{ provider: payload\.provider, model: payload\.model \?\? "" \};/,
  );
  check("failed 路由对 selection 也构造（不再 undefined）", failedDecl !== null);
  check("冷却写入发生在 failed 定义之后", src.indexOf("cooldowns.set(") > src.indexOf("const failed ="));

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
}

console.log("");
console.log(`结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
