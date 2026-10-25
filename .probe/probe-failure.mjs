// What exactly in the `failure` object is not JSON-serializable?
//
// The turn died with: session event "llm/retry" carries non-JSON-serializable data
// dsh-llm-retry appends `llm/retry` with the payload's `failure` verbatim
// (dsh-llm-retry/lib/index.js:141), and dsh-session rejects the event when
// snapshotJsonValue(data) returns undefined.
//
// This reproduces the check with the real failure shape taken from the
// session log, so the offending field is identified rather than guessed.
import { readFileSync } from "node:fs";

// The exact failure the real run produced (from the decoded session).
const lines = readFileSync("/tmp/session-decoded.jsonl", "utf8").split("\n").filter(Boolean);
let failure = null;
for (const l of lines) {
  if (l.includes('"free-models-per-day"')) {
    const m = /"failure":(\{.*?\})\]/s.exec(l);
    if (m) { try { failure = JSON.parse(m[1]); } catch { /* keep looking */ } }
  }
}
if (failure === null) {
  // fall back: take the finish chunk's failure verbatim from the parsed event
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    const chunks = e?.data?.stream;
    if (!Array.isArray(chunks)) continue;
    for (const c of chunks) {
      if (c?.chunk?.reason?.failure) { failure = c.chunk.reason.failure; break; }
    }
    if (failure) break;
  }
}
console.log("=== the failure object from the real run ===");
console.log(JSON.stringify(failure, null, 2));
console.log("");

// dsh-session's rule: undefined, BigInt, function, symbol, NaN/Infinity,
// negative zero, circular refs, sparse arrays, Map/Set/Date/class instances.
const BAD = new Set(["undefined", "bigint", "function", "symbol", "number", "object"]);
function why(value, path = "") {
  const problems = [];
  const seen = new WeakSet();
  function walk(v, p) {
    if (v === undefined) { problems.push(`${p}: undefined`); return; }
    const t = typeof v;
    if (t === "bigint" || t === "function" || t === "symbol") { problems.push(`${p}: ${t}`); return; }
    if (t === "number") {
      if (!Number.isFinite(v)) problems.push(`${p}: non-finite number`);
      if (Object.is(v, -0)) problems.push(`${p}: negative zero`);
      return;
    }
    if (t !== "object" || v === null) return;
    if (seen.has(v)) { problems.push(`${p}: circular reference`); return; }
    seen.add(v);
    if (v instanceof Map || v instanceof Set || v instanceof Date) { problems.push(`${p}: ${v.constructor.name}`); return; }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) { problems.push(`${p}: class instance (${proto?.constructor?.name})`); }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i += 1) {
        if (!(i in v)) { problems.push(`${p}[${i}]: sparse array`); continue; }
        walk(v[i], `${p}[${i}]`);
      }
      return;
    }
    for (const key of Object.keys(v)) walk(v[key], p === "" ? key : `${p}.${key}`);
  }
  walk(value, path);
  return problems;
}

const problems = why(failure);
console.log("=== what dsh-session would reject ===");
console.log(problems.length === 0 ? "  (nothing — the failure itself is serializable)" : problems.map((p) => "  " + p).join("\n"));
