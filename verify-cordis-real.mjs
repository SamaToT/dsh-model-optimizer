// 真实 cordis 瀑布流测试：用真的 cordis + 真的插件，注入一个假的 llm 服务，
// 触发真的 agent/request-error 事件，验证 escalate 落点。
//
// 修复前：手选模型失败 -> escalate 到 pos=0（永远同一个模型）
// 修复后：escalate 到不同的 pos，且失败路由进入冷却
import { createRequire } from "node:module";
import path from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

const require = createRequire(import.meta.url);
const tmp = path.join(homedir(), "AppData", "Local", "Temp", "cordis-real");
const cordisMod = await import(pathToFileURL(path.join(tmp, "node_modules", "@deepseek-ai", "cordis", "lib", "index.js")).href);
const { Context } = cordisMod;

const pluginPath = path.resolve("index.js");
const plugin = await import(pathToFileURL(pluginPath).href);

const logPath = path.join(homedir(), ".dsh", "fixcheck-cordis.log");
rmSync(logPath, { force: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  -> " + detail : ""}`); }
};

// A fake llm service: three providers, each with a couple of models.
const PROVIDERS = {
  "our-free-model": ["kilo-auto/free", "minimax/minimax-m3.1-flash:free"],
  "workbuddy": ["hy3", "step-5-preview"],
  freestuff: ["m1", "m2"],
};

const ctx = new Context();
const llm = {
  async listProviders() { return Object.keys(PROVIDERS); },
  async listModels(provider) { return PROVIDERS[provider] ?? []; },
  async resolveModelInfo(provider, model) {
    return { provider, model, efforts: ["off", "low", "medium", "high"] };
  },
};
ctx.provide("llm", llm);

const config = {
  chain: [
    { provider: "our-free-model", model: "kilo-auto/free" },
    { provider: "our-free-model", model: "minimax/minimax-m3.1-flash:free" },
    { provider: "workbuddy", model: "hy3" },
    { provider: "workbuddy", model: "step-5-preview" },
    { provider: "freestuff", model: "m1" },
  ],
  cooldownMs: 30000,
  retriesBeforeSwitch: 0,
  escalateOnTransient: true,
  escalateOn: ["RATE_LIMIT", "INVALID_REQUEST", "SERVER", "QUOTA"],
  debugLog: logPath,
  neutralizeIdentityFor: ["workbuddy"],
};

// cordis v4: ctx.plugin(plugin, config) starts the plugin and calls its
// apply(ctx, config) once the injected services exist.
await ctx.plugin(plugin, config);

console.log("=== A. 手选模型失败 -> escalate 不应落在 pos=0 ===");
// The user selected our-free-model/kilo-auto/free, which IS chain[0].
// Simulate: that route fails. The escalation must not land on it again.
const key = "session-cordis-check|1";
const turn = "session-cordis-check|1";
const step = 1;

const failRoute = async (provider, model, code = "RATE_LIMIT", agent = undefined) => {
  // ctx.emit does not return the waterfall result, so the decision is captured
  // from the payload the plugin logs.
  await ctx.emit("agent/request-error", {
    turn, step, signal: undefined,
    provider, model,
    failure: { code },
    ...(agent === undefined ? {} : { agent }),
  });
};

await failRoute("our-free-model", "kilo-auto/free");

// Read back which route the plugin picked: fire agent/request and capture the
// resolved config from inside the waterfall.
let requested;
await ctx.emit("agent/request", { turn, step, signal: undefined }, async () => {
  requested = { provider: "our-free-model", model: "kilo-auto/free" };
  return requested;
});
// The plugin overrides the resolved value, so read it back through a second
// pass that observes the result of the waterfall chain.
const { readFileSync, existsSync } = await import("node:fs");
const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";

const escalateLine = (log.match(/escalate pos=(\d+) -> (\S+)/) ?? []);
const escalatePos = escalateLine[1] !== undefined ? Number(escalateLine[1]) : -1;
const escalateTo = escalateLine[2];

check("escalate 落点不是 0（修复前恒为 0）", escalatePos >= 1, `pos=${escalatePos} -> ${escalateTo}`);
check("escalate 选中的不是刚失败的那条路由", escalateTo !== "our-free-model/kilo-auto/free", escalateTo);
check("日志里有 cooldown 记录（失败路由进入冷却）", /cooldown our-free-model\/kilo-auto\/free/.test(log),
  (log.match(/cooldown \S+/g) || []).join(" | "));

console.log("");
console.log("=== B. 链上多个模型轮换，不会永远压一个 ===");
// Fail the escalated route too: the next escalation must move further down.
await failRoute("our-free-model", "minimax/minimax-m3.1-flash:free");
const logAfter = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
const allEscalations = (logAfter.match(/escalate pos=(\d+) -> (\S+)/g) || []);
const positions = allEscalations.map((l) => Number(/escalate pos=(\d+)/.exec(l)[1]));
check("第二次 escalate 落到了更靠后的位置", positions.length >= 2 && positions[1] > positions[0],
  allEscalations.join(" | "));
check("每次 escalate 都前进（不重复落点）", new Set(positions).size === positions.length,
  allEscalations.join(" | "));
check("每个失败的路由都进了冷却",
  (logAfter.match(/cooldown our-free-model\//g) || []).length >= 2,
  (logAfter.match(/cooldown \S+/g) || []).join(" | "));

console.log("");
console.log("=== C. 中和判定按 session 精确定位 ===");
// Two sessions with different routes. The prompt for session B must be judged
// against B's route, not A's.
const agentA = { id: "session-A", options: { provider: "workbuddy", model: "hy3" } };
const agentB = { id: "session-B", options: { provider: "freestuff", model: "m1" } };

await ctx.emit("agent/request", { turn: "session-A|1", step: 1, signal: undefined, agent: agentA }, async () => ({
  provider: "workbuddy", model: "hy3",
}));
await ctx.emit("agent/request", { turn: "session-B|1", step: 1, signal: undefined, agent: agentB }, async () => ({
  provider: "freestuff", model: "m1",
}));

const before = logAfter.length;
await ctx.emit("system-prompt/assemble", { sections: [{ name: "harness:identity", text: "You are an AI agent powered by DeepSeek Harness." }] }, { agent: agentA }, async () => ({ sections: [{ name: "harness:identity", text: "You are an AI agent powered by DeepSeek Harness." }] }));
await ctx.emit("system-prompt/assemble", { sections: [{ name: "harness:identity", text: "You are an AI agent powered by DeepSeek Harness." }] }, { agent: agentB }, async () => ({ sections: [{ name: "harness:identity", text: "You are an AI agent powered by DeepSeek Harness." }] }));
const after = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
const newLines = after.slice(before).split("\n").filter((l) => l.includes("neutralized"));
check("只有 workbuddy 那个 session 触发了中和", newLines.length === 1,
  `新增 ${newLines.length} 条: ${newLines.join(" | ")}`);
check("中和记录指向 workbuddy", newLines.some((l) => l.includes("workbuddy")), newLines.join(" | "));

console.log("");
console.log("=== D. escalate 后，下一次 assemble 立刻反映新路由 ===");
// The prompt is assembled BEFORE the request runs, so the escalation has to
// update the session's route at escalation time — not when the next request
// is resolved. A prompt that is one step behind decides the identity rewrite
// against the previous route.
//
// The invariant is that the provider the rewrite is decided on is the provider
// the escalation landed on, whatever that provider happens to be.
const agentC = { id: "session-C", options: { provider: "workbuddy", model: "hy3" } };
await ctx.emit("agent/request", { turn: "session-C|1", step: 1, signal: undefined, agent: agentC }, async () => ({
  provider: "workbuddy", model: "hy3",
}));
// Escalate away from workbuddy.
await ctx.emit("agent/request-error", {
  turn: "session-C|1", step: 1, provider: "workbuddy", model: "hy3",
  failure: { code: "INVALID_REQUEST" }, signal: undefined, agent: agentC,
}, async () => undefined);

const logBeforeD = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
// The LAST escalation is this session's one; earlier lines belong to the
// other sessions in this file.
const escalateLines = logBeforeD.match(/escalate pos=\d+ -> \S+/g) || [];
const escalateTarget = (escalateLines[escalateLines.length - 1] ?? "").match(/-> ([^/]+)\//)?.[1];
await ctx.emit("system-prompt/assemble", { sections: [{ name: "harness:identity", text: "You are an AI agent powered by DeepSeek Harness." }] }, { agent: agentC }, async () => ({ sections: [{ name: "harness:identity", text: "You are an AI agent powered by DeepSeek Harness." }] }));
const afterD = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
const newD = afterD.slice(logBeforeD.length).split("\n").filter((l) => l.includes("neutralized"));
const decided = (newD[0] ?? "").match(/for provider (\S+)/)?.[1];
const neutralized = ["workbuddy"];
if (escalateTarget !== undefined && neutralized.includes(escalateTarget)) {
  check("中和判定与 escalate 目标一致", decided === escalateTarget,
    `escalate 到 ${escalateTarget}，中和判定 ${decided}`);
} else {
  check("escalate 目标不在中和列表时不做中和", newD.length === 0,
    `escalate 到 ${escalateTarget}，新增 ${newD.length} 条: ${newD.join(" | ")}`);
}

console.log("");
console.log(`结果: ${pass} 通过, ${fail} 失败`);
await ctx.fiber.dispose();
process.exit(fail === 0 ? 0 : 1);
