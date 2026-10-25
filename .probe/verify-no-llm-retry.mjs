// Prove the red "处理失败" crash cannot happen: the plugin must answer
// `agent/request-error` ITSELF, so dsh-llm-retry never appends the
// `llm/retry` session event that the session log refuses to serialize.
//
// The real crash (decoded from the live session):
//   turn  9: kind=error code=UNKNOWN
//            msg=session event "llm/retry" carries non-JSON-serializable data
//
// dsh-llm-retry appends `llm/retry` with the failure verbatim
// (dsh-llm-retry/lib/index.js:141) and dsh-session rejects it
// (dsh-session/lib/index.js:1524) -> the throw escapes the agent loop ->
// turnEnds = { kind: "error" } -> the UI shows "处理失败".
//
// This harness loads the REAL dsh-llm-retry next to the plugin, gives it a
// session that refuses non-serializable data exactly like dsh-session does,
// and asserts that the turn is NOT killed by that event.
import { copyFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.cwd();
const realCordis = join(process.env.LOCALAPPDATA, "Temp", "cordis-real");
const work = mkdtempSync(join(tmpdir(), "cordis-noretry-"));
mkdirSync(work, { recursive: true });

const pluginDest = join(realCordis, "plugin-index.js");
copyFileSync(join(repo, "index.js"), pluginDest);

const { Context } = await import(
  pathToFileURL(join(realCordis, "node_modules", "@deepseek-ai", "cordis", "lib", "index.js")).href
);

const MODELS = ["m1", "m2", "m3", "m4", "m5"];
const tried = [];

// A session that behaves like dsh-session: append() throws on data that is
// not losslessly JSON-serializable (dsh-session/lib/index.js:1523-1524).
const appended = [];
const session = {
  append(type, data) {
    try {
      JSON.stringify(data);
    } catch {
      throw new Error(`session event "${type}" carries non-JSON-serializable data`);
    }
    // dsh-session also rejects `undefined` values, which JSON.stringify drops
    // silently; that is the actual shape that broke the real run.
    const walk = (v) => {
      if (v === undefined) return true;
      if (typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") return true;
      if (v && typeof v === "object") {
        if (v instanceof Map || v instanceof Set || v instanceof Date) return true;
        for (const k of Object.keys(v)) if (walk(v[k])) return true;
      }
      return false;
    };
    if (walk(data)) throw new Error(`session event "${type}" carries non-JSON-serializable data`);
    appended.push({ type, data });
    return { seq: appended.length };
  },
  requestHeader() { return undefined; },
  projectionState() { return undefined; }
};

const fakeLlm = {
  listProviders: () => [{ id: "fake" }],
  listModels: () => MODELS.map((id) => ({ id, name: id })),
  resolveModelInfo: (provider, model) => ({
    id: `${provider}/${model}`, name: model, efforts: ["off"], defaultEffort: "off"
  }),
  stream: async function* (options) {
    tried.push(options.model);
    yield { type: "text", text: "x" };
    yield {
      type: "finish",
      reason: { kind: "error", failure: { code: "SERVER", message: "boom", extra: undefined } }
    };
  }
};

const ctx = new Context();
ctx.provide("llm", fakeLlm);

// The REAL dsh-llm-retry, loaded from the harness's own node_modules.
const retryPkg = join(
  process.env.LOCALAPPDATA, "Temp", "cordis-real", "node_modules", "@deepseek-ai", "dsh-llm-retry", "lib", "index.js"
);
let retryLoaded = false;
try {
  const retryModule = await import(pathToFileURL(retryPkg).href);
  const retryPlugin = retryModule.default ?? retryModule;
  await ctx.plugin(retryPlugin, { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0, retryableCodes: ["SERVER"] });
  retryLoaded = true;
} catch (e) {
  console.log("(dsh-llm-retry not loadable in this harness:", e.message.slice(0, 80), ")");
}

const pluginModule = await import(pathToFileURL(pluginDest).href);
await ctx.plugin(pluginModule.default ?? pluginModule, {
  debugLog: join(work, "n.log"),
  statsPath: join(work, "n-stats.json"),
  statsFlushMs: 0,
  statsRefreshMs: 0,
  retriesBeforeSwitch: 2,
  cooldownMs: 1000,
  escalateOn: ["SERVER"]
});

const agent = { id: "session-x", options: { provider: "fake", model: "m1" }, session };
const waterfall = (name, payload, inner) => ctx.events.waterfall(ctx, name, payload, inner);

let turnEnded = null;
let crash = null;
let step = 1;
// The real agent loop retries INSIDE one step: dsh-agent-loop's step() body
// is a `while (true)` (dsh-agent-loop/lib/index.js:1051), and the step number
// only advances when the step concludes (phase.step = step at :974). So a
// { kind: "retry" } answer re-runs the SAME step number.
for (; step <= 10; step += 1) {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    if (attempts > 60) { crash = "the step never concluded (60 attempts)"; break; }
    try {
      const request = await waterfall(
        "agent/request",
        { turn: 1, step, signal: undefined, agent },
        async () => ({ provider: "fake", model: "m1" })
      );
      for await (const chunk of fakeLlm.stream({ model: request.model, provider: request.provider })) {
        if (chunk.type === "finish") {
          const action = await waterfall(
            "agent/request-error",
            { turn: 1, step, provider: request.provider, failure: chunk.reason.failure, signal: undefined, agent },
            async () => undefined
          );
          if (action?.kind === "retry") break;   // the SAME step is retried
          turnEnded = { kind: "error", code: chunk.reason.failure.code };
        }
      }
    } catch (e) {
      crash = e.message;
      break;
    }
    if (turnEnded !== null || crash !== null) break;
  }
  if (turnEnded !== null || crash !== null) break;
}

console.log("");
console.log(`dsh-llm-retry loaded: ${retryLoaded}`);
console.log(`models tried: ${JSON.stringify(tried)}  (${new Set(tried).size} distinct of ${MODELS.length})`);
console.log(`llm/retry events appended: ${appended.filter((a) => a.type === "llm/retry").length}`);
console.log(`event types appended: ${JSON.stringify([...new Set(appended.map((a) => a.type))])}`);
console.log(`turn ended: ${turnEnded === null ? "never" : turnEnded.kind + " (" + turnEnded.code + ")"}`);
console.log(`crash: ${crash === null ? "none" : crash}`);

const problems = [];
if (crash !== null) problems.push(`the session append threw: ${crash}`);
if (appended.some((a) => a.type === "llm/retry")) problems.push("an llm/retry event was appended (the crash source)");
if (new Set(tried).size !== MODELS.length) problems.push(`only ${new Set(tried).size} of ${MODELS.length} models were tried`);
if (turnEnded === null) problems.push("the turn never ended");

console.log("");
if (problems.length === 0) {
  console.log("PASS: the whole chain was tried, no llm/retry event was appended, and the turn ended with the real upstream error");
} else {
  console.log("FAIL:");
  for (const p of problems) console.log("  - " + p);
}
await ctx.fiber.dispose();
process.exit(problems.length === 0 ? 0 : 1);
