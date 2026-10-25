// Real-cordis v4 harness for the §5 features.
//
// This runs the REAL plugin inside a REAL cordis v4 context, with a fake `llm`
// service, and drives the REAL waterfalls. It is the same shape the DSH
// runtime uses:
//
//   ctx.waterfall("agent/request",        payload, seed)
//   ctx.waterfall("llm/stream",           request, adapterStream)
//   ctx.waterfall("agent/request-error",  payload, () => undefined)
//
// It asserts the §5 behaviour against what the plugin actually logs, because
// `ctx.emit` does not return a waterfall result.
//
// The §5 features under test:
//   5.2  the cooldown window depends on the failure code
//   5.3  the success/failure counters are recorded and persisted
//   5.1  the chain is ordered by the measured success rate
//
// Run: node verify-cordis-real.mjs

import path from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { readFileSync, existsSync, rmSync, mkdirSync, copyFileSync } from "node:fs";

const tmp = path.join(homedir(), "AppData", "Local", "Temp", "cordis-real");
const cordisMod = await import(
  pathToFileURL(path.join(tmp, "node_modules", "@deepseek-ai", "cordis", "lib", "index.js")).href
);
const { Context } = cordisMod;

// The plugin is COPIED into the temp directory before it is imported.
//
// This is not a convenience: the plugin imports "@deepseek-ai/schemastery",
// and Node resolves that bare specifier by walking up from the file's own
// directory. The workspace has no node_modules, so the import would fail
// there. The temp directory does have one, so the copy resolves — exactly the
// way the real profile resolves it from
// ~/.dsh/profiles/desktop/node_modules/dsh-model-optimizer.
//
// The copy is taken fresh on every run, so the test always exercises the
// current source and never a stale copy.
const pluginCopy = path.join(tmp, "plugin-index.js");
copyFileSync(path.resolve("index.js"), pluginCopy);
const plugin = await import(pathToFileURL(pluginCopy).href);

const workDir = path.join(tmp, "verify-5");
mkdirSync(workDir, { recursive: true });
const logPath = path.join(workDir, "llm-failover.log");
const statsPath = path.join(workDir, "stats.json");
rmSync(logPath, { force: true });
rmSync(statsPath, { force: true });

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass += 1; console.log(`  PASS ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? "  -> " + detail : ""}`); }
};

const readLog = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");

// ---------------------------------------------------------------------------
// The fake llm service.
//
// It is the same three-method surface the real DSH runtime exposes to a
// plugin: listProviders(), listModels(provider), resolveModelInfo(p, m).
//
// listModels returns OBJECTS, not bare strings: the real DSH llm service
// returns model records with an `id` and a display `name`, and the plugin
// reads `model.id` and `model.name` (the name carries the price label). A
// fake that returned strings would make the plugin discover zero routes, and
// the test would then assert against an empty chain.
// ---------------------------------------------------------------------------
const PROVIDERS = {
  "our-free-model": ["kilo-auto/free", "minimax/minimax-m3.1-flash:free"],
  workbuddy: ["hy3", "step-5-preview"],
  freestuff: ["m1", "m2"]
};

const ctx = new Context();
ctx.provide("llm", {
  async listProviders() {
    return Object.keys(PROVIDERS).map((id) => ({ id }));
  },
  async listModels(provider) {
    return (PROVIDERS[provider] ?? []).map((id) => ({ id, name: id }));
  },
  async resolveModelInfo(provider, model) {
    return { provider, model, reasoning: { efforts: [{ id: "off" }, { id: "low" }], defaultEffort: "off" } };
  }
});

const config = {
  // No explicit `chain`: the chain is DISCOVERED from the providers, which is
  // the path the reliability ordering applies to. An explicit chain is
  // returned verbatim and is never reordered, so testing the reorder against
  // one would test nothing.
  //
  // The catalog paths point at files that DO NOT EXIST, so the test does not
  // read the machine's real free-model ranking or the real WorkBuddy price
  // list. Without this the tiers would depend on whatever is installed on
  // this computer, and the test would pass or fail for reasons that have
  // nothing to do with the plugin.
  rankingCatalogPath: path.join(workDir, "no-such-ranking.json"),
  workBuddyCatalogPath: path.join(workDir, "no-such-price.json"),
  availabilityPath: path.join(workDir, "no-such-availability.json"),
  cooldownMs: 30000,
  retriesBeforeSwitch: 0,
  escalateOnTransient: true,
  escalateOn: ["RATE_LIMIT", "INVALID_REQUEST", "SERVER", "QUOTA", "AUTH"],
  debugLog: logPath,
  statsPath,
  statsWindow: 10,
  statsMinSamples: 2,
  statsRefreshMs: 0,
  statsFlushMs: 0,
  neutralizeIdentityFor: ["workbuddy"]
};

await ctx.plugin(plugin, config);

const events = ctx.events;

// ---------------------------------------------------------------------------
// A waterfall helper that mirrors the DSH runtime.
//
// `ctx.events.waterfall(this, name, ...args, inner)` is the real cordis
// waterfall: the listeners run outermost-first and the last argument is the
// innermost `next`.
// ---------------------------------------------------------------------------
const waterfall = (name, payload, inner) => events.waterfall(ctx, name, payload, inner);

console.log("=== A. §5.2 the cooldown window depends on the failure code ===");

const agentA = { id: "session-A", options: { provider: "our-free-model", model: "kilo-auto/free" } };

// Register the selection the way the request stage does.
await waterfall("agent/request", { turn: 1, step: 1, signal: undefined, agent: agentA },
  async () => ({ provider: "our-free-model", model: "kilo-auto/free" }));

// A rate limit: the window must be the LONG one (the upstream resets in
// minutes), not the flat 30s default.
await waterfall("agent/request-error", {
  turn: 1, step: 1, provider: "our-free-model",
  failure: { code: "RATE_LIMIT" }, signal: undefined, agent: agentA
}, async () => undefined);

let log = readLog();
const rateLimitCooldown = (log.match(/cooldown our-free-model\/kilo-auto\/free for (\d+)ms \(RATE_LIMIT\)/) ?? [])[1];
check("RATE_LIMIT 的冷却窗口比默认 30s 长", rateLimitCooldown !== undefined && Number(rateLimitCooldown) > 30000,
  `window=${rateLimitCooldown}ms`);
check("RATE_LIMIT 的冷却窗口是 5 分钟（默认值）", rateLimitCooldown === "300000", `window=${rateLimitCooldown}ms`);

// A rejected request: permanent, so it must be longer than a rate limit.
const agentB = { id: "session-B", options: { provider: "our-free-model", model: "minimax/minimax-m3.1-flash:free" } };
await waterfall("agent/request", { turn: 1, step: 1, signal: undefined, agent: agentB },
  async () => ({ provider: "our-free-model", model: "minimax/minimax-m3.1-flash:free" }));
await waterfall("agent/request-error", {
  turn: 1, step: 1, provider: "our-free-model",
  failure: { code: "INVALID_REQUEST" }, signal: undefined, agent: agentB
}, async () => undefined);

log = readLog();
const invalidRequestCooldown = (log.match(/cooldown our-free-model\/minimax\/minimax-m3\.1-flash:free for (\d+)ms \(INVALID_REQUEST\)/) ?? [])[1];
check("INVALID_REQUEST 的冷却窗口比 RATE_LIMIT 长（永久性失败）",
  invalidRequestCooldown !== undefined && Number(invalidRequestCooldown) > Number(rateLimitCooldown),
  `window=${invalidRequestCooldown}ms vs ${rateLimitCooldown}ms`);

console.log("");
console.log("=== B. §5.3 the counters are recorded and persisted ===");

// Drive a real `llm/stream` waterfall: the plugin's listener must see the
// terminal chunk and record the outcome.
const streamRequest = (provider, model, kind) => {
  const chunks = [
    { type: "text", text: "hello" },
    { type: "finish", reason: kind === "ok" ? { kind: "stop" } : { kind: "error", failure: { code: "SERVER", message: "boom" } } }
  ];
  return waterfall("llm/stream", { provider, model, messages: [] }, () => ({
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    }
  }));
};

const consumed = async (iterable) => {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
};

const okStream = await streamRequest("our-free-model", "kilo-auto/free", "ok");
const okChunks = await consumed(okStream);
check("成功的一次调用原样透传了所有 chunk", okChunks.length === 2, `chunks=${okChunks.length}`);
check("终止 chunk 的 kind 原样透传", okChunks[1]?.reason?.kind === "stop", JSON.stringify(okChunks[1]));

const failStream = await streamRequest("workbuddy", "hy3", "fail");
await consumed(failStream);

log = readLog();
check("成功被记为 ok", /outcome ok our-free-model\/kilo-auto\/free \(stop\)/.test(log),
  (log.match(/outcome \S+ \S+ \([^)]+\)/g) || []).join(" | "));
check("失败被记为 fail", /outcome fail workbuddy\/hy3 \(error\)/.test(log),
  (log.match(/outcome \S+ \S+ \([^)]+\)/g) || []).join(" | "));

// The counters must be on disk.
//
// The file is read HERE, right after the first pair of outcomes, so the
// assertion is about those two outcomes and not about the ones the later
// section records.
check("统计文件已写入", existsSync(statsPath), statsPath);
if (existsSync(statsPath)) {
  const raw = JSON.parse(readFileSync(statsPath, "utf8"));
  const kilo = raw.routes?.["our-free-model/kilo-auto/free"];
  const hy3 = raw.routes?.["workbuddy/hy3"];
  check("成功计数落盘 (kilo ok=1)", kilo?.ok === 1, JSON.stringify(kilo));
  check("失败计数落盘 (hy3 bad=1)", hy3?.bad === 1, JSON.stringify(hy3));
  check("统计文件带版本号", raw.version === 1, JSON.stringify(raw.version));
  // The recent-outcome bits are what the sliding success rate is computed
  // from. The kilo route has TWO outcomes by now: the RATE_LIMIT failure
  // from section A and the success from section B — both are real, and both
  // are counted exactly once.
  check("统计文件记录了近期结果位（用于滑窗成功率）",
    typeof kilo?.bits === "string" && kilo.bits.length === 2 && kilo.bits === "01",
    JSON.stringify(kilo));
  check("失败只被计一次（流与错误处理器不会重复计数）",
    kilo?.bad === 1 && hy3?.bad === 1,
    `kilo=${JSON.stringify(kilo)} hy3=${JSON.stringify(hy3)}`);
}

console.log("");
console.log("=== C. §5.1 the chain is ordered by the measured success rate ===");

// Record enough outcomes to move a route: `workbuddy/hy3` fails, the free
// models succeed. Then the chain must put the free models first.
//
// The stats window is 10 and the minimum sample count is 2, so a route needs
// two outcomes before its rate counts.
for (let i = 0; i < 4; i += 1) {
  await consumed(await streamRequest("workbuddy", "hy3", "fail"));
}
for (let i = 0; i < 4; i += 1) {
  await consumed(await streamRequest("our-free-model", "kilo-auto/free", "ok"));
}
for (let i = 0; i < 4; i += 1) {
  await consumed(await streamRequest("our-free-model", "minimax/minimax-m3.1-flash:free", "ok"));
}

// Force a chain rebuild: the refresh interval is 0 in this config, so the
// next buildChain() re-sorts.
const agentC = { id: "session-C", options: { provider: "freestuff", model: "m1" } };
await waterfall("agent/request", { turn: 9, step: 9, signal: undefined, agent: agentC },
  async () => ({ provider: "freestuff", model: "m1" }));

log = readLog();
const chainLines = log.match(/chain free=[\s\S]*?:: (.*)/g) || [];
const lastChain = chainLines[chainLines.length - 1] ?? "";
const order = (lastChain.match(/([a-z-]+\/[^\s>]+)/g) || []);
check("链序按成功率重排：workbuddy/hy3 掉到 free 两条之后",
  order.indexOf("workbuddy/hy3") > order.indexOf("our-free-model/kilo-auto/free"),
  `chain order: ${order.join(" > ")}`);
check("链序按成功率重排：minimax 排在 hy3 之前",
  order.indexOf("our-free-model/minimax/minimax-m3.1-flash:free") < order.indexOf("workbuddy/hy3"),
  `chain order: ${order.join(" > ")}`);

console.log("");
console.log("=== D. the cost tiers never move (free stays before credits) ===");

// The tier of every route, as the plugin classifies it with the built-in
// rules: our-free-model is free, workbuddy is credits, and an unknown
// provider is "paid" (the conservative default — never treat a third-party
// key as free).
const tierOf = (key) => {
  const provider = key.split("/")[0];
  if (provider === "our-free-model") return 0; // free
  if (provider === "workbuddy") return 1;      // credits
  return 2;                                   // paid
};
const tierOrder = order.map(tierOf);
const isSorted = tierOrder.every((tier, index) => index === 0 || tier >= tierOrder[index - 1]);
check("成本层顺序没有被成功率打乱（free -> credits -> paid）", isSorted,
  `tiers: ${tierOrder.join(",")} for ${order.join(" > ")}`);

// And the counts the plugin itself reported must agree with that.
const tierCounts = (lastChain.match(/free=(\d+) credits=(\d+) paid=(\d+)/) ?? []).slice(1).map(Number);
check("插件报告的层计数与链长一致",
  tierCounts.length === 3 && tierCounts.reduce((a, b) => a + b, 0) === order.length,
  `free=${tierCounts[0]} credits=${tierCounts[1]} paid=${tierCounts[2]} chain=${order.length}`);

console.log("");
console.log("=== E. 报错前切：用户选的路由在冷却中时，请求发出去就换走 ===");

// The bug this reproduces, from the REAL App log:
//
//   request step=53:45 ... provider=workbuddy model=step-5-preview
//   request-error step=53:45 provider=workbuddy code=RATE_LIMIT
//   request step=53:46 ... provider=workbuddy model=step-5-preview   <- again!
//
// 46 times in the real log a LATER step sent the request back to the route
// that had just failed. The cause: the `agent/request` handler returned the
// user's selection for a new step WITHOUT asking whether it was in cooldown.
// The cooldown was only consulted while walking the chain, never for the
// selection — so the error was shown first and the switch came after it.
//
// A NEW session, so the plugin's per-step state is empty and this is a
// first request of a step, exactly like the failing case.
const agentD = { id: "session-D", options: { provider: "workbuddy", model: "hy3" } };

// The selection is registered the way the request stage does it.
await waterfall("agent/request", { turn: 20, step: 1, signal: undefined, agent: agentD },
  async () => ({ provider: "workbuddy", model: "hy3" }));

// The route fails with a permanent code, so it enters a long cooldown.
await waterfall("agent/request-error", {
  turn: 20, step: 1, provider: "workbuddy",
  failure: { code: "INVALID_REQUEST" }, signal: undefined, agent: agentD
}, async () => undefined);

log = readLog();
check("失败路由已进入冷却",
  /cooldown workbuddy\/hy3 for \d+ms \(INVALID_REQUEST\)/.test(log),
  (log.match(/cooldown \S+ for \d+ms \([^)]+\)/g) || []).join(" | "));

// The NEXT request of a new step: the plugin must NOT send it back to the
// route that just failed. This is the whole point.
await waterfall("agent/request", { turn: 21, step: 1, signal: undefined, agent: agentD }, async () => ({
  provider: "workbuddy", model: "hy3"
}));

// The log is read AFTER the request, so the plugin's own line is in it.
log = readLog();
const preemptLine = (log.match(/preempt step=\S+ -> \S+ is cooling down; switching to (\S+)/) ?? [])[1];
check("新 step 的请求没有再打回刚失败的路由",
  preemptLine !== undefined,
  (log.match(/preempt \S+.*/g) || []).join(" | "));
check("提前切到了别的路由", preemptLine !== undefined && preemptLine !== "workbuddy/hy3",
  `preempt -> ${preemptLine}`);

// And the route it picked must be one that is NOT in cooldown.
const coolingRoutes = new Set(
  (log.match(/cooldown (\S+) for \d+ms/g) || []).map((l) => /cooldown (\S+) for/.exec(l)[1])
);
check("提前切到的路由不在冷却中", preemptLine !== undefined && !coolingRoutes.has(preemptLine),
  `preempt -> ${preemptLine}; 冷却中: ${[...coolingRoutes].join(", ")}`);

// A route that is NOT in cooldown must still be used normally: the plugin
// must not write off a model because of an old failure.
//
// `freestuff/m2` was never tried and never failed, so it is the clean case.
const agentE = { id: "session-E", options: { provider: "freestuff", model: "m2" } };
const before = readLog().length;
await waterfall("agent/request", { turn: 22, step: 1, signal: undefined, agent: agentE },
  async () => ({ provider: "freestuff", model: "m2" }));
const afterLog = readLog().slice(before);
check("没在冷却中的路由照常使用（不因为旧失败被拉黑）",
  !afterLog.includes("is cooling down"),
  afterLog.trim().split("\n").join(" | "));

// And the route that IS in cooldown must be skipped even when the user
// selects it directly in a brand new session.
const agentF = { id: "session-F", options: { provider: "workbuddy", model: "hy3" } };
const beforeF = readLog().length;
await waterfall("agent/request", { turn: 23, step: 1, signal: undefined, agent: agentF },
  async () => ({ provider: "workbuddy", model: "hy3" }));
const afterF = readLog().slice(beforeF);
check("换一个会话也照样避开冷却中的路由",
  afterF.includes("is cooling down") && !afterF.includes("provider=workbuddy model=hy3"),
  afterF.trim().split("\n").join(" | "));

console.log("");
console.log(`结果: ${pass} 通过, ${fail} 失败`);
await ctx.fiber.dispose();
process.exit(fail === 0 ? 0 : 1);
