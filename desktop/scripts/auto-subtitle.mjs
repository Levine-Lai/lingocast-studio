#!/usr/bin/env node
/**
 * One-command YouTube -> bilingual subtitle project pipeline.
 *
 *   node scripts/auto-subtitle.mjs --url "https://www.youtube.com/watch?v=..."
 *     [--verified-json '["Name"]'] [--corrections-json '{"Wrong":"Right"}']
 *     [--name "Project name"] [--model small.en] [--skip-align] [--keep-temp]
 *
 * Requires the video-subs skill scripts (default %USERPROFILE%\.codex\skills\video-subs,
 * override with VIDEO_SUBS_SKILL), yt-dlp, FFmpeg, Python + faster-whisper, and the
 * LingoCast automation-enabled desktop app (launched automatically when missing).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const desktopDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const skillDir = process.env.VIDEO_SUBS_SKILL || join(homedir(), ".codex", "skills", "video-subs");
const options = parseArgs(process.argv.slice(2));
if (!options.url) fail("Usage: node scripts/auto-subtitle.mjs --url \"https://www.youtube.com/watch?v=...\" [options]");

const verifiedJson = jsonArgument(options["verified-json"], []);
const correctionsJson = jsonArgument(options["corrections-json"], {});
const model = options.model || "small.en";
const workDir = join(desktopDir, ".automation");
mkdirSync(workDir, { recursive: true });
let tempDb = "";

try {
  step("1/8 准备视频、字幕与封面");
  const prepared = runJson(process.execPath, [
    join(skillDir, "scripts", "import_to_lingocast.mjs"),
    "--url", options.url,
    "--prepare-only",
  ], { timeout: 30 * 60_000, label: "video-subs prepare" });
  const videoId = prepared.videoId;
  log(`素材：${prepared.title}（${Math.round(prepared.durationSeconds)} 秒）`);

  step("2/8 复制数据库并运行 DeepSeek 语义分句/翻译");
  const liveDb = join(process.env.APPDATA || "", "com.lingocast.studio", "lingocast-studio.db");
  if (!existsSync(liveDb)) fail(`找不到 LingoCast 数据库：${liveDb}`);
  const tempDbPath = join(workDir, `auto-${videoId}.db`);
  tempDb = tempDbPath;
  copyFileSync(liveDb, tempDb);
  const projectName = options.name || prepared.title;
  const imported = runJson(process.execPath, [
    "--experimental-strip-types",
    join(desktopDir, "scripts", "import-reviewed-project.mjs"),
    tempDb,
    prepared.videoPath,
    prepared.srtPath,
    projectName,
    prepared.channel || "",
    prepared.description || "",
    verifiedJson,
    correctionsJson,
  ], {
    timeout: 30 * 60_000,
    label: "DeepSeek import",
    env: { VIDEO_SUBS_TRANSLATOR: "deepseek", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
  });
  log(`生成 ${imported.cueCount} 条双语字幕`);

  let timings = null;
  if (!options["skip-align"]) {
    step("3/8 生成词级时间戳");
    timings = ensureWordTimings(prepared, videoId, model);
    if (timings) {
      step("4/8 对齐字幕到词边界并平衡间隙");
      const aligned = runJson("python", [
        join(skillDir, "scripts", "align_project_word_timings.py"),
        "--db", tempDb, "--project", imported.projectId, "--timings", timings,
      ], { timeout: 10 * 60_000, label: "word alignment" });
      const balanced = runJson("python", [
        join(skillDir, "scripts", "balance_project_gaps.py"),
        "--db", tempDb, "--project", imported.projectId,
        "--minimum-gap-ms", "80", "--ordinary-gap-ms", "180",
      ], { timeout: 10 * 60_000, label: "gap balance" });
      log(`覆盖 ${aligned.matchedCueCount}/${aligned.cueCount}，平均 ${aligned.averageCoverage}；间隙调整 ${balanced.changedCueCount} 条`);
    } else {
      log("跳过对齐：没有可用的词级时间戳");
    }
  }

  step("5/8 读取结果并合并明显断句");
  const durationMs = Number(queryJson(tempDb, `SELECT duration_ms FROM projects WHERE id=${sqlText(imported.projectId)};`)[0].duration_ms);
  const rows = queryJson(tempDb, `SELECT position,start_ms,end_ms,source_text,target_text,speaker FROM cues WHERE project_id=${sqlText(imported.projectId)} ORDER BY position;`);
  const cues = mergeDanglingCues(rows.map((row) => ({
    startMs: Number(row.start_ms),
    endMs: Math.min(Number(row.end_ms), Math.floor(durationMs) - 40),
    sourceText: row.source_text,
    targetText: row.target_text,
    speaker: row.speaker || "",
    kind: "subtitle",
    subtitleStyle: {},
    status: "draft",
  })));
  if (!cues.length) fail("导入后没有任何字幕");
  log(`${rows.length} -> ${cues.length} 条（合并 ${rows.length - cues.length} 条断句）`);

  step("6/8 确认自动化实例");
  ensureAgent();
  const existing = queryJson(liveDb, `SELECT id FROM projects WHERE video_path=${sqlText(prepared.videoPath)} LIMIT 1;`);
  const projectId = existing[0]?.id || "";
  step("7/8 写入项目");
  const response = projectId
    ? runAgent({ action: "replace-cues", params: { projectId, cues } }, 10 * 60_000)
    : runAgent({ action: "import", params: { name: projectName, videoPath: prepared.videoPath, cues } }, 10 * 60_000);
  const targetProjectId = response.result?.projectId || projectId;
  if (!targetProjectId) fail("软件没有返回 projectId");

  step("8/8 校验");
  const project = waitForProject(targetProjectId, 60_000);
  const finalCues = project.cues || [];
  const durations = finalCues.map((cue) => cue.endMs - cue.startMs);
  const gaps = finalCues.slice(0, -1).map((cue, index) => finalCues[index + 1].startMs - cue.endMs);
  const problems = [];
  finalCues.forEach((cue, index) => {
    if (!cue.targetText.trim()) problems.push(`位置 ${index} 缺少中文`);
    if (cue.endMs <= cue.startMs) problems.push(`位置 ${index} 时长无效`);
    if (index && cue.startMs < finalCues[index - 1].endMs) problems.push(`位置 ${index} 与上一条重叠`);
    if (cue.endMs > project.durationMs) problems.push(`位置 ${index} 超出视频时长`);
  });
  if (!finalCues.length || problems.length) fail(`校验失败：${problems.slice(0, 8).join("；") || "没有字幕"}`);

  const summary = {
    ok: true,
    projectId: targetProjectId,
    name: project.name,
    videoId,
    videoPath: project.videoPath,
    cueCount: finalCues.length,
    translatedCueCount: finalCues.filter((cue) => cue.targetText.trim()).length,
    durationMs: project.durationMs,
    minDurationMs: Math.min(...durations),
    maxDurationMs: Math.max(...durations),
    averageDurationMs: Math.round(durations.reduce((total, value) => total + value, 0) / durations.length),
    naturalGaps: gaps.filter((gap) => gap >= 80 && gap <= 240).length,
    shortGaps: gaps.filter((gap) => gap < 80).length,
    longGaps: gaps.filter((gap) => gap > 1200).length,
    alignment: timings ? "word-level" : "provider-timing",
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  if (!options["keep-temp"] && tempDb) {
    rmSync(tempDb, { force: true });
  }
}

function step(message) {
  process.stderr.write(`[auto-subtitle] ${message}\n`);
}
function log(message) {
  process.stderr.write(`[auto-subtitle] ${message}\n`);
}
function fail(message) {
  process.stderr.write(`[auto-subtitle] ${message}\n`);
  process.exit(1);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) fail(`未知参数：${value}`);
    const key = value.slice(2);
    if (["skip-align", "keep-temp"].includes(key)) parsed[key] = true;
    else {
      if (index + 1 >= values.length) fail(`参数 --${key} 缺少值`);
      parsed[key] = values[++index];
    }
  }
  return parsed;
}

function jsonArgument(value, fallback) {
  if (!value) return JSON.stringify(fallback);
  const source = value.startsWith("@") ? readFileSync(resolve(value.slice(1)), "utf8") : value;
  try {
    JSON.parse(source);
  } catch {
    fail(`无法解析 JSON 参数：${source.slice(0, 80)}`);
  }
  return source;
}

function run(command, args, { timeout = 10 * 60_000, env, label = command } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout,
    maxBuffer: 128 * 1024 * 1024,
    env: {
      ...process.env,
      ...(env || {}),
    },
  });
  if (result.error) fail(`${label} 启动失败：${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim().split(/\r?\n/).slice(-6).join("\n");
    fail(`${label} 失败（退出码 ${result.status}）${detail ? `：\n${detail}` : ""}`);
  }
  return result;
}

function runJson(command, args, options = {}) {
  const result = run(command, args, { ...options, env: { ...process.env, ...(options.env || {}), PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
  const lines = String(result.stdout || "").trim().split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines.slice(index).join("\n"));
    } catch { /* try an earlier line */ }
  }
  fail(`${options.label || command} 没有返回 JSON`);
}

function queryJson(db, sql) {
  const result = spawnSync("sqlite3", ["-json", db, sql], { encoding: "utf8", windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) fail(result.stderr || "SQLite 查询失败");
  return JSON.parse(result.stdout || "[]");
}

function sqlText(value) {
  return `CAST(X'${Buffer.from(String(value), "utf8").toString("hex")}' AS TEXT)`;
}

function ensureWordTimings(prepared, videoId, model) {
  const existing = join(workDir, `${videoId}.word-timings.json`);
  if (existsSync(existing) && statSync(existing).size > 100) {
    log(`复用词级时间戳：${basename(existing)}`);
    return existing;
  }
  const modelPath = findWhisperModel(model);
  if (!modelPath) {
    log(`没有找到本地 Whisper 模型 ${model}，本次跳过词级对齐`);
    return null;
  }
  const output = join(workDir, `${videoId}.word-timings.json`);
  const result = spawnSync("python", [
    join(skillDir, "scripts", "transcribe_word_timings.py"),
    "--input", prepared.videoPath,
    "--output", output,
    "--model", modelPath,
    "--initial-prompt", "Sports commentary, players, teams, brands, and technical terms",
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60 * 60_000,
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, ...offlineEnv(), PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
  });
  if (result.error || result.status !== 0) {
    log(`Whisper 词级时间戳失败，跳过对齐：${String(result.stderr || result.error?.message || "").trim().split(/\r?\n/).slice(-3).join(" ")}`);
    return null;
  }
  return existsSync(output) && statSync(output).size > 100 ? output : null;
}

function findWhisperModel(model) {
  const hub = join(homedir(), ".cache", "huggingface", "hub");
  const prefix = `models--Systran--faster-whisper-${model}`;
  const root = join(hub, prefix, "snapshots");
  if (!existsSync(root)) return null;
  const snapshots = readdirSync(root).filter((name) => existsSync(join(root, name))).sort();
  return snapshots.length ? join(root, snapshots.at(-1)) : null;
}

function offlineEnv() {
  const env = { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", NO_PROXY: "*" };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) env[key] = "";
  return env;
}

function mergeDanglingCues(input) {
  const FUNCTION_END = /\b(a|an|the|and|or|but|because|if|when|while|although|though|unless|until|since|so|than|as|that|which|who|whom|whose|what|where|why|how|to|of|in|on|at|by|for|from|with|into|about|after|before|like|his|her|their|our|your|my|this|these|those|is|are|was|were|has|have|had|will|would|could|should)\s*$/i;
  const TARGET_END = /(?:再次|目标是|时候|因为|所以|但是|而且|以及|然后|如果|虽然|除非|直到|为了|关于|他说|她说|他们说|这意味着|也就是)$/u;
  const result = [];
  for (const cue of input) {
    const previous = result.at(-1);
    if (previous
      && (FUNCTION_END.test(previous.sourceText.trim()) || TARGET_END.test(previous.targetText.trim()))
      && cue.endMs - previous.startMs <= 9_500
      && `${previous.sourceText} ${cue.sourceText}`.length <= 160
      && `${previous.targetText} ${cue.targetText}`.replace(/\s+/g, " ").length <= 52
    ) {
      previous.endMs = cue.endMs;
      previous.sourceText = `${previous.sourceText} ${cue.sourceText}`.replace(/\s+/g, " ").trim();
      previous.targetText = `${previous.targetText} ${cue.targetText}`.replace(/\s+/g, " ").trim();
    } else {
      result.push({ ...cue });
    }
  }
  return result.map((cue, position) => ({ ...cue, position }));
}

function waitForProject(projectId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return runAgent({ action: "get", params: { projectId } }, 30_000).result;
    } catch (error) {
      lastError = error;
      spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 800)"], { timeout: 2_000 });
    }
  }
  throw lastError || new Error("项目读取超时");
}

function ensureAgent() {
  const status = (() => {
    try {
      return runAgent({ action: "status" }, 15_000);
    } catch {
      return null;
    }
  })();
  if (status) return;
  log("没有运行中的自动化实例，正在启动…");
  run(process.execPath, [join(desktopDir, "scripts", "agent.mjs"), "--launch"], { timeout: 120_000, label: "agent launch" });
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      runAgent({ action: "status" }, 10_000);
      return;
    } catch {
      spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { timeout: 2_000 });
    }
  }
  fail("自动化实例启动超时");
}

function runAgent(request, timeout) {
  const requestPath = join(tmpdir(), `lingocast-auto-${process.pid}-${Date.now()}.json`);
  writeFileSync(requestPath, JSON.stringify(request), "utf8");
  try {
    const result = spawnSync(process.execPath, [
      join(desktopDir, "scripts", "agent.mjs"),
      "--request", requestPath,
      "--timeout", String(Math.ceil(timeout / 1000)),
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: timeout + 60_000,
      maxBuffer: 128 * 1024 * 1024,
    });
    if (result.error) throw new Error(`agent ${request.action} 启动失败：${result.error.message}`);
    const line = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean).at(-1) || "";
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      throw new Error(`agent ${request.action} 返回无效 JSON：${line.slice(0, 200)}`);
    }
    if (!response.ok) throw new Error(response.error || `agent ${request.action} 失败`);
    return response;
  } finally {
    rmSync(requestPath, { force: true });
  }
}
