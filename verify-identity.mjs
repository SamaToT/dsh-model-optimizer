// 验证 identity 中和：只对指定 provider 生效
import path from "node:path";
import { homedir } from "node:os";

const base = path.join(homedir(), ".dsh", "profiles", "desktop");
const { createRequire } = await import("node:module");
const req = createRequire(path.join(base, "package.json"));
const sm = req("@deepseek-ai/schemastery");
const plugin = await import("file:///" + path.join(base, "node_modules", "dsh-model-optimizer", "index.js").replace(/\\/g, "/"));

let pass = 0, fail = 0;
const check = (n, ok, d) => { console.log(`  ${ok ? "PASS" : "FAIL"} ${n}${ok ? "" : " -- " + d}`); ok ? pass++ : fail++; };

function mk(extra) {
  const llm = {
    listProviders: async () => ["workbuddy", "our-free-model"].map((id) => ({ id })),
    listModels: async (p) => p === "workbuddy"
      ? [{ provider: p, id: "hy3", name: "Hy3" }]
      : [{ provider: p, id: "kilo-auto/free", name: "Kilo" }],
    resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
  };
  const events = {};
  const ctx = {
    logger: { debug: () => {}, warn: () => {} },
    on: (ev, fn) => { (events[ev] ||= []).push(fn); return () => {}; },
    effect: () => {},
    get: (s) => (s === "llm" ? llm : undefined),
    llm,
  };
  plugin.apply(ctx, sm.resolve(extra, plugin.Config)[0]);
  async function wf(ev, ...args) {
    const ls = events[ev] ?? [];
    let i = 0;
    const last = args[args.length - 1];
    const hasNext = typeof last === "function";
    const payload = hasNext ? args.slice(0, -1) : args;
    const n = async () => {
      if (i < ls.length) {
        const fn = ls[i++];
        return fn(...payload, n);
      }
      return hasNext ? last() : undefined;
    };
    return n();
  }
  return { wf };
}

const ASSEMBLY = {
  sections: [
    { name: "harness:identity", text: "You are an AI agent powered by DeepSeek Harness." },
    { name: "deployment:persona:prefix", text: "" },
    { name: "tool:bash", text: "Bash tool" },
  ],
  variables: {},
  contexts: [],
  tools: [],
};

async function assembleFor(provider, extra) {
  const { wf } = mk(extra);
  const context = { agent: { options: { provider, model: "hy3" } }, scope: {} };
  return wf("system-prompt/assemble", ASSEMBLY, context, () => Promise.resolve(ASSEMBLY));
}

console.log("=== 配置了 neutralizeIdentityFor: [workbuddy] ===");
{
  const cfg = { neutralizeIdentityFor: ["workbuddy"] };
  const wb = await assembleFor("workbuddy", cfg);
  const wbText = wb.sections.find((s) => s.name === "harness:identity")?.text;
  check("workbuddy 的 identity 被中和", wbText === "You are a helpful assistant.", String(wbText));
  check("workbuddy 其它 section 不变", wb.sections.find((s) => s.name === "tool:bash")?.text === "Bash tool");

  const ofm = await assembleFor("our-free-model", cfg);
  const ofmText = ofm.sections.find((s) => s.name === "harness:identity")?.text;
  check("其它 provider 的 identity 不变", ofmText === "You are an AI agent powered by DeepSeek Harness.", String(ofmText));
}

console.log("\n=== 默认（不配置）时所有 provider 都不改 ===");
{
  const wb = await assembleFor("workbuddy", {});
  const t = wb.sections.find((s) => s.name === "harness:identity")?.text;
  check("workbuddy 的 identity 保持原样", t === "You are an AI agent powered by DeepSeek Harness.", String(t));
}

console.log("\n=== prompt 正文一字不改 ===");
{
  const custom = {
    ...ASSEMBLY,
    sections: [
      { name: "harness:identity", text: "You are an AI agent powered by DeepSeek Harness." },
      { name: "custom", text: "MY IMPORTANT INSTRUCTIONS" },
    ],
  };
  const { wf } = mk({ neutralizeIdentityFor: ["workbuddy"] });
  const out = await wf("system-prompt/assemble", custom, { agent: { options: { provider: "workbuddy" } } }, () => Promise.resolve(custom));
  check("custom section 原样保留", out.sections.find((s) => s.name === "custom")?.text === "MY IMPORTANT INSTRUCTIONS");
  check("section 数量不变", out.sections.length === custom.sections.length, `${out.sections.length} vs ${custom.sections.length}`);
}

console.log("\n=== failover 激活时用 failover 的路由判定 ===");
{
  const { wf } = mk({ neutralizeIdentityFor: ["workbuddy"] });
  // 先让 workbuddy 失败切换到 our-free-model
  await wf("agent/request", { turn: 1, step: 1, signal: {} }, () => ({ provider: "workbuddy", model: "hy3" }));
  await wf("agent/request-error", { turn: 1, step: 1, provider: "workbuddy", model: "hy3", failure: { code: "INVALID_REQUEST" }, signal: {} }, () => undefined);
  // 现在 active route 是 our-free-model，即使 agent.options 还是 workbuddy
  const out = await wf("system-prompt/assemble", ASSEMBLY, { agent: { options: { provider: "workbuddy", model: "hy3" } } }, () => Promise.resolve(ASSEMBLY));
  const t = out.sections.find((s) => s.name === "harness:identity")?.text;
  check("已切到 our-free-model -> identity 不该被中和", t === "You are an AI agent powered by DeepSeek Harness.", String(t));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
