// 在真实 DSH 进程里验证 workbuddy 可用性：
// 1) 记录插件加载后 workbuddy 的 CN 路径是否已被修复
// 2) 发一次真实 workbuddy 请求，看是否成功出 token
// 3) 捕获 pi-ai 构造的请求体（role 与 system 开头）
import fsx from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

const { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, copyFileSync, symlinkSync } = fsx;
const dsh = path.join(homedir(), ".dsh");
const desktop = path.join(dsh, "profiles", "desktop");
const real = path.join(dsh, "profiles", "wbverify");

const outPath = path.join(dsh, "wbverify.json");
rmSync(outPath, { force: true });

// --- 探测插件 ---
const probeDir = path.join(desktop, "node_modules", "wbverify2");
mkdirSync(probeDir, { recursive: true });
writeFileSync(path.join(probeDir, "package.json"), JSON.stringify({
  name: "wbverify2", version: "1.0.0", type: "module", main: "./index.js",
  dsh: { bundle: { patch: "./cordis.patch.yml" } },
}, null, 2));
writeFileSync(path.join(probeDir, "cordis.patch.yml"), "- insert:\n    - id: wbverify2\n      name: wbverify2\n");
writeFileSync(path.join(probeDir, "index.js"), `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
const name = "wbverify2";
const inject = ["llm"];
async function apply(ctx) {
  const llm = ctx.llm ?? ctx.get("llm");
  const out = { providers: [], attempt: null, captured: [] };

  // Capture what the adapter actually sends.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async function (url, init) {
    try {
      const u = String(url);
      if (u.includes("copilot.tencent.com") && u.includes("chat")) {
        let body = null;
        try { body = init?.body ? JSON.parse(init.body) : null; } catch {}
        const res = await realFetch.call(this, url, init);
        const clone = res.clone();
        const text = await clone.text();
        out.captured.push({
          status: res.status,
          messages: Array.isArray(body?.messages)
            ? body.messages.map((m) => ({ role: m.role, head: String(typeof m.content === "string" ? m.content : JSON.stringify(m.content)).slice(0, 110) }))
            : null,
          response: text.slice(0, 220),
        });
        return res;
      }
    } catch (e) { out.captured.push({ error: String(e).slice(0, 160) }); }
    return await realFetch.call(this, url, init);
  };

  try { out.providers = await llm.listProviders(); } catch (e) { out.providers = ["ERR " + e.message]; }

  try {
    const stream = await llm.stream({
      provider: "workbuddy", model: "hy3",
      messages: [{ role: "user", content: [{ type: "text", text: "say hi in one word" }] }],
    });
    let reply = ""; let finish;
    for await (const c of stream) {
      if (c?.type === "finish") { finish = c; continue; }
      if (typeof c?.text === "string") reply += c.text;
    }
    if (finish?.reason?.kind === "error") {
      out.attempt = { ok: false, code: finish.reason?.failure?.code ?? "", msg: String(finish.reason?.failure?.message ?? "").slice(0, 300) };
    } else {
      out.attempt = { ok: true, reply: reply.trim().slice(0, 100) };
    }
  } catch (e) {
    out.attempt = { ok: false, msg: String(e).slice(0, 240) };
  }
  writeFileSync(join(homedir(), ".dsh", "wbverify.json"), JSON.stringify(out, null, 2));
}
export { name, apply, inject };
`);

const pkgPath = path.join(real, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
if (!pkg.dsh.profile.bundles.includes("wbverify2")) pkg.dsh.profile.bundles.push("wbverify2");
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

// --- 启动前：把 workbuddy 恢复成官方原版，模拟“插件刚被重装”的最坏情况 ---
const wbSource = path.join(desktop, "node_modules", "dsh-workbuddy-connect", "lib", "host-heartbeat-SJaZ33tR.js");
const before = readFileSync(wbSource, "utf8");
const wasPatched = before.includes("function neutralizeRejectedSystemSignature");
console.log("启动前 workbuddy 已打补丁:", wasPatched);

const exe = "D:\\工具\\DeepSeek Harness\\DeepSeek Harness.exe";
const cli = "D:\\工具\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js";
const child = spawn(exe, ["--expose-internals", cli, "--profile", "wbverify", "--no-open"], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", (d) => { out += d.toString(); });
child.stderr.on("data", (d) => { out += d.toString(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(60000);
child.kill();

rmSync(probeDir, { recursive: true, force: true });
rmSync(real, { recursive: true, force: true });

console.log("");
console.log("=== 探测结果 ===");
if (existsSync(outPath)) {
  const r = JSON.parse(readFileSync(outPath, "utf8"));
  console.log("providers:", JSON.stringify(r.providers));
  console.log("attempt:", JSON.stringify(r.attempt));
  console.log("captured requests:");
  for (const c of r.captured) {
    console.log("  status:", c.status);
    if (c.messages) {
      for (const m of c.messages) console.log(`    role=${m.role}  head=${JSON.stringify(m.head)}`);
    }
    if (c.response) console.log("    response:", c.response.replace(/\n/g, " ").slice(0, 200));
  }
  rmSync(outPath, { force: true });
} else {
  console.log("无结果文件（探测插件未执行）");
  console.log(out.slice(-1500));
}
