// Integration check against a running automation-enabled desktop app.
// Uses synthetic media and deletes only its own project after success.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "lingocast-agent-smoke-"));
const cli = fileURLToPath(new URL("./agent.mjs", import.meta.url));
let counter = 0;
async function rpc(action, params = {}) {
  const request = join(directory, `request-${counter++}.json`);
  await writeFile(request, JSON.stringify({ action, params }));
  for (let attempt = 0; attempt < 100; attempt++) {
    let stdout;
    try { ({ stdout } = await exec(process.execPath, [cli, "--request", request, "--timeout", "120"], { windowsHide: true })); }
    catch (error) { stdout = error.stdout; if (!stdout) throw error; }
    const response = JSON.parse(stdout);
    if (response.error === "Editor busy or has unsaved changes; save and retry") {
      await new Promise((done) => setTimeout(done, 250));
      continue; // Explicit rejection occurred before any mutation.
    }
    assert.equal(response.ok, true, response.error);
    return response.result;
  }
  throw new Error("App did not accept request");
}
async function ready() {
  for (let i = 0; i < 30; i++) {
    const status = await rpc("status");
    if (!status.busy && !status.dirty) return status;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error("App remained busy");
}
const status = await ready();
assert.equal(status.version, JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../package.json", import.meta.url), "utf8")).version);
const source = join(directory, "source.mp4");
await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=640x360:r=24:d=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-c:a", "aac", "-shortest", source], { windowsHide: true });
const cues = [{ startMs: 0, endMs: 2900, sourceText: "Agent export", targetText: "自动化导出" },
  { startMs: 0, endMs: 2900, kind: "note", targetText: "注释轨道", subtitleStyle: { positionY: 65 } }];
const { projectId } = await rpc("import", { videoPath: source, name: "Automation smoke test", cues });
await ready();
assert.ok((await rpc("list")).some((project) => project.id === projectId));
let project = await rpc("get", { projectId });
assert.equal(project.cues.length, 2);
assert.equal(project.durationMs, 3000);
await rpc("replace-cues", { projectId, cues: project.cues });
await ready();
await rpc("style", { projectId, style: { backgroundEnabled: false } });
await ready();
await rpc("segments", { projectId, segments: [{ startMs: 0, endMs: 1000, removed: false }, { startMs: 1000, endMs: 2000, removed: true }, { startMs: 2000, endMs: 3000, removed: false }] });
await ready();
const srt = await rpc("srt", { projectId });
assert.ok(srt.includes("自动化导出"));
assert.ok(srt.includes("00:00:01,900"));
const outputPath = join(directory, "burned.mp4");
const burned = await rpc("burn", { projectId, outputPath });
assert.equal(burned.videoPath, outputPath);
const { stdout } = await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", outputPath], { windowsHide: true });
assert.ok(Math.abs(Number(JSON.parse(stdout).format.duration) - 2) < 0.15);
// Burned pixels must differ from the flat-blue source, proving overlays exist.
const { stdout: frame } = await exec("ffmpeg", ["-v", "error", "-ss", "0.5", "-i", outputPath, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { windowsHide: true, encoding: "buffer", maxBuffer: 20 * 1024 * 1024 });
let brightPixels = 0;
for (let i = 0; i < frame.length; i += 3) if (frame[i] > 150 && frame[i + 1] > 150) brightPixels++;
assert.ok(brightPixels > 100, "Subtitle pixels missing from export");
await exec("ffmpeg", ["-v", "error", "-ss", "0.5", "-i", outputPath, "-frames:v", "1", join(directory, "burned.png")], { windowsHide: true });
await ready();
project = await rpc("get", { projectId });
assert.ok(project.burnedAt);
await rpc("delete", { projectId });
await ready();
assert.ok(!(await rpc("list")).some((project) => project.id === projectId));
console.log(JSON.stringify({ ok: true, version: status.version, directory, brightPixels, tested: ["status", "list", "import", "get", "replace-cues", "style", "segments", "srt", "burn", "delete"] }));
