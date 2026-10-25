// Prove: the plugin walks the WHOLE chain and only reports a failure when
// EVERY route has been tried.
//
// The bug this reproduces (from the real session log):
//   turn 9:  kind=error code=UNKNOWN
//            msg=session event "llm/retry" carries non-JSON-serializable data
// The turn died on the FIRST failure because dsh-llm-retry's session event
// threw. The chain was never walked.
//
// This harness simulates the real agent loop (dsh-agent-loop:1136-1146):
//   agent/request      -> resolve { provider, model }
//   llm/stream         -> the adapter call; here it always fails
//   agent/request-error-> if the plugin answers { kind: "retry" }, the step
//                         is retried; otherwise the turn ends with the error.
import { readFileSync, existsSync, rmSync, copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.cwd();
const realCordis = join(process.env.LOCALAPPDATA, "Temp", "cordis-real");
const work = mkdtempSync(join(tmpdir(), "cordis-exhaust-"));
mkdirSync(work, { recursive: true });

const pluginDest = join(realCordis, "plugin-index.js");
copyFileSync(join(repo, "index.js"), pluginDest);

const { Context } = await import(
  pathToFileURL(join(realCordis, "node_modules", "@deepseek-ai", "cordis", "lib", "index.js")).href
);

const logPath = join(work, "exhaust.log");
const statsPath = join(work, "exhaust-stats.json");
rmSync(logPath, { force: true });
rmSync(statsPath, { force: true });

const MODELS = ["m1", "m2", "m3", "m4", "m5"];
const tried = [];

const fakeLlm = {
  listProviders: () => [{ id: "fake" }],
  listModels: () => MODELS.map((id) => ({ id, name: id })),
  resolveModelInfo: (provider, model) => ({
    id: `${provider}/${model}`, name: model, efforts: ["off"], defaultEffort: "off"
  }),
  stream: async function* (options) {
    tried.push(options.model);
    yield { type: "text", text: "x" };
    yield { type: "finish", reason: { kind: "error", failure: { code: "SERVER", message: "boom" } } };
  }
};

const ctx = new Context();
ctx.provide("llm", fakeLlm);
const pluginModule = await import(pathToFileURL(pluginDest).href);
await ctx.plugin(pluginModule.default ?? pluginModule, {
  debugLog: logPath,
  statsPath,
  statsFlushMs: 0,
  statsRefreshMs: 0,
  retriesBeforeSwitch: 0,
  cooldownMs: 1000,
  escalateOn: ["SERVER"]
});

const agent = { id: "session-x", options: { provider: "fake", model: "m1" } };
const waterfall = (name, payload, inner) => ctx.events.waterfall(ctx, name, payload, inner);

// --- the real agent loop, simulated -----------------------------------------
// dsh-agent-loop runs `while (true)` over steps. A failed step goes through
// agent/request-error; { kind: "retry" } re-runs the step.
let turnEnded = null;
let step = 1;
const seen = [];
for (; step <= 40; step += 1) {
  const request = await waterfall(
    "agent/request",
    { turn: 1, step, signal: undefined, agent },
    async () => ({ provider: "fake", model: "m1" })
  );
  const route = `${request.provider}/${request.model}`;
  if (seen.includes(route) === false) seen.push(route);

  // The adapter call. The plugin's llm/stream listener sees the terminal chunk.
  for await (const chunk of fakeLlm.stream({ model: request.model, provider: request.provider })) {
    if (chunk.type === "finish") {
      const action = await waterfall(
        "agent/request-error",
        {
          turn: 1, step, provider: request.provider,
          failure: chunk.reason.failure, signal: undefined, agent
        },
        async () => undefined
      );
      if (action?.kind === "retry") break;   // the step is retried
      turnEnded = { kind: "error", code: chunk.reason.failure.code };
    }
  }
  if (turnEnded !== null) break;
}

console.log("");
console.log(`turn ended: ${turnEnded === null ? "never" : turnEnded.kind + " (" + turnEnded.code + ")"}`);
console.log(`routes the loop asked for: ${JSON.stringify(seen)}`);
console.log(`routes the adapter actually tried: ${JSON.stringify(tried)}`);
const distinct = new Set(tried);
console.log(`distinct models tried: ${distinct.size} of ${MODELS.length}`);

const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
const escalations = log.split("\n").filter((l) => l.includes("escalate pos="));
console.log("");
console.log(`escalation trail (${escalations.length} steps):`);
for (const l of escalations) console.log("  " + l.slice(l.indexOf("escalate"), l.indexOf("escalate") + 60));

console.log("");
const ok = distinct.size === MODELS.length && turnEnded !== null;
console.log(ok
  ? "PASS: every model in the chain was tried, and only then did the turn fail"
  : `FAIL: ${distinct.size} of ${MODELS.length} models tried (turnEnded=${JSON.stringify(turnEnded)})`);
await ctx.fiber.dispose();
process.exit(ok ? 0 : 1);
