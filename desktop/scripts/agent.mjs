#!/usr/bin/env node
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (key) => {
  const index = args.indexOf(key);
  return index < 0 ? undefined : args[index + 1];
};
if (!args.length || args.includes("--help")) {
  console.log(`LingoCast agent RPC (Node 22+)
  node scripts/agent.mjs --launch
  node scripts/agent.mjs status
  node scripts/agent.mjs list
  node scripts/agent.mjs --request request.json [--timeout 3600]
  node scripts/agent.mjs get '{"projectId":"..."}'
JSON response on stdout; nonzero exit on error. See AUTOMATION.md.`);
  process.exit(0);
}
try {
  if (args.includes("--launch")) {
    let bundle = fileURLToPath(new URL("../src-tauri/target/release/bundle/", import.meta.url));
    let manifestText;
    try { manifestText = await readFile(join(bundle, "latest.json"), "utf8"); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      bundle = fileURLToPath(new URL("./", import.meta.url));
      manifestText = await readFile(join(bundle, "latest.json"), "utf8");
    }
    const manifest = JSON.parse(manifestText);
    const executable = resolve(bundle, manifest.file);
    const actual = createHash("sha256").update(await readFile(executable)).digest("hex");
    if (actual !== manifest.sha256.toLowerCase()) throw new Error("Portable executable hash mismatch; rebuild before launching");
    const child = spawn(executable, [], { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, LINGOCAST_AUTOMATION: "1" } });
    await new Promise((done, fail) => { child.once("spawn", done); child.once("error", fail); });
    child.unref();
    console.log(JSON.stringify({ ok: true, result: { launched: executable, version: manifest.version } }));
  } else {
    if (!process.env.APPDATA) throw new Error("Windows APPDATA is required");
    const directory = join(process.env.APPDATA, "com.lingocast.studio", "automation");
    await mkdir(directory, { recursive: true });
    const request = option("--request")
      ? JSON.parse((await readFile(resolve(option("--request")), "utf8")).replace(/^\uFEFF/, ""))
      : { action: args[0], params: args[1] && !args[1].startsWith("--") ? JSON.parse(args[1]) : {} };
    if (!request || typeof request.action !== "string") throw new Error("Request needs an action string");
    const timeout = Number(option("--timeout") || 600);
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid timeout in seconds");
    const id = randomUUID();
    const base = join(directory, id);
    const deadline = Date.now() + timeout * 1000;
    await writeFile(`${base}.tmp`, JSON.stringify({ ...request, id, deadline }), { flag: "wx" });
    await rename(`${base}.tmp`, `${base}.request.json`);
    for (;;) {
      let result;
      try { result = await readFile(`${base}.response.json`, "utf8"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (result !== undefined) {
        const response = JSON.parse(result);
        await unlink(`${base}.response.json`);
        console.log(JSON.stringify(response));
        if (!response.ok) process.exitCode = 1;
        break;
      }
      if (Date.now() > deadline) {
        let started = true;
        try { await unlink(`${base}.request.json`); started = false; } catch (error) { if (error.code !== "ENOENT") throw error; }
        throw new Error(`Timed out (${id}). ${started ? "Job may still be running; do not resubmit a mutation. Check its response file or project state." : "Not started. Launch the latest app with automation enabled."}`);
      }
      await new Promise((done) => setTimeout(done, 200));
    }
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
}
