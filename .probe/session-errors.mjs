// Which turns ended with an error? The UI shows "处理失败" exactly when
// turn/end carries reason.kind === "error" (dsh-client-ui-chat:6629, fed by
// dsh-agent-loop:1019).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

const sessionDir = join(
  homedir(), ".dsh", "sessions",
  "--C-Users-Administrator-Documents-deepseek-harness-default-workspace--",
  "session-a18b8b1d-d0b7-4b42-a4d9-f641afec844c"
);
const file = join(sessionDir, "session.v4.jsonl.zstd");

let text;
try {
  text = zstdDecompressSync(readFileSync(file)).toString("utf8");
} catch (e) {
  console.log("decompress failed:", e.message.slice(0, 200));
  process.exit(1);
}

const lines = text.split("\n").filter(Boolean);
console.log(`session lines: ${lines.length}`);

const turns = [];
const eventNames = new Map();
for (const line of lines) {
  let ev;
  try { ev = JSON.parse(line); } catch { continue; }
  const type = ev?.type ?? ev?.event?.type;
  const data = ev?.data ?? ev?.event?.data;
  eventNames.set(type, (eventNames.get(type) ?? 0) + 1);
  if (type === "turn/end") {
    turns.push({ reason: data?.reason?.kind, code: data?.reason?.error?.code, turn: data?.turn });
  }
}
console.log(`turn/end events: ${turns.length}`);
console.log("");
console.log("event kinds seen (top 20):");
for (const [k, n] of [...eventNames].sort((a,b)=>b[1]-a[1]).slice(0,20)) console.log(`  ${k}: ${n}`);
console.log("");
const errs = turns.filter((t) => t.reason === "error");
console.log(`turns ended with error: ${errs.length} / ${turns.length}`);
for (const t of errs.slice(-25)) console.log(`  turn ${t.turn}: ${t.reason} code=${t.code ?? "(none)"}`);
console.log("");
const byCode = {};
for (const t of errs) byCode[t.code ?? "(none)"] = (byCode[t.code ?? "(none)"] ?? 0) + 1;
console.log("error codes:");
for (const [c, n] of Object.entries(byCode).sort((a, b) => b[1] - a[1])) console.log(`  ${c}: ${n}`);
