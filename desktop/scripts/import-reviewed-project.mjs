import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { buildBilingualCues } from "../src/lib/srt.ts";
import { DEFAULT_SUBTITLE_STYLE } from "../src/types.ts";

const [dbPath, videoPath, srtPath, title, channel, description, verifiedJson = "[]", correctionsJson = "{}", forcedProjectId = ""] = process.argv.slice(2);
if (![dbPath, videoPath, srtPath, title].every(Boolean)) throw new Error("缺少项目导入参数");

function envFile(path) {
  const values = {};
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return values;
}

const config = {
  ...envFile(new URL("../../.env.local", import.meta.url)),
  ...envFile(join(process.env.APPDATA || "", "com.lingocast.studio", ".env.local")),
};
const apiKey = process.env.DEEPSEEK_API_KEY || config.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("没有找到 DEEPSEEK_API_KEY");
const apiBase = (process.env.DEEPSEEK_API_BASE || config.DEEPSEEK_API_BASE || "https://api.deepseek.com").replace(/\/$/, "");
const model = process.env.DEEPSEEK_MODEL || config.DEEPSEEK_MODEL || "deepseek-chat";
function parseList(value) {
  try { return JSON.parse(value); } catch { return value.split("|").map((item) => item.trim()).filter(Boolean); }
}
function parseCorrections(value) {
  try { return JSON.parse(value); } catch {
    return Object.fromEntries(value.split("|").map((item) => item.split("=>").map((part) => part.trim())).filter((parts) => parts.length === 2));
  }
}
const verifiedTerms = parseList(verifiedJson);
const corrections = parseCorrections(correctionsJson);

const tracks = [{ language: "en-orig", content: readFileSync(srtPath, "utf8") }];
const cues = buildBilingualCues(tracks).map((cue) => {
  let sourceText = cue.sourceText;
  for (const [wrong, correct] of Object.entries(corrections)) sourceText = sourceText.replaceAll(wrong, correct);
  return { ...cue, sourceText };
});

// Persist successful translation batches beside the source SRT. Long podcast
// imports can then resume after a transient API disconnect or app interruption.
const translationSignature = createHash("sha256").update(JSON.stringify({
  title, channel, description, verifiedTerms, corrections,
  source: cues.map((cue) => cue.sourceText),
})).digest("hex").slice(0, 16);
const translationCachePath = `${srtPath}.${translationSignature}.zh-cache.json`;
if (existsSync(translationCachePath)) {
  try {
    const cachedItems = JSON.parse(readFileSync(translationCachePath, "utf8")).items || [];
    for (const item of cachedItems) {
      if (!Number.isInteger(item.index) || !cues[item.index] || !item.zh?.trim()) continue;
      cues[item.index].sourceText = stripStop(item.en?.trim() || cues[item.index].sourceText);
      cues[item.index].targetText = stripStop(item.zh.trim());
      cues[item.index].speaker = item.speaker?.trim() || "";
    }
  } catch { /* Ignore an incomplete cache and refill missing entries. */ }
}

function saveTranslationCache() {
  const items = cues.flatMap((cue, index) => cue.targetText ? [{
    index,
    en: cue.sourceText,
    zh: cue.targetText,
    speaker: cue.speaker || "",
  }] : []);
  writeFileSync(translationCachePath, `${JSON.stringify({ items })}\n`, "utf8");
}

const systemPrompt = `你是专业的中英双语口语视频字幕编辑，只返回 JSON。结合视频标题、频道、简介、verifiedTerms 和前后字幕，先校正英文自动字幕里的高置信度人名、地名、队名、品牌和专业术语，再翻译成自然简洁的简体中文口语字幕。en 只能修正明确的转录错误、大小写和专名拼写，禁止改写普通口语；证据不足时保留原文。zh 要符合中国人口头表达，可省略无意义填充词和无意义重复，但不得丢失事实、否定、数字和观点。经过上下文或检索确认的英文人名，在 zh 中必须直接保留校正后的拉丁字母完整拼写，禁止音译、意译或替换成中文姓名；例如 Dylan Cease 在中文字幕中仍写作 Dylan Cease。每个 index 必须返回一次，不能合并、拆分、错序或省略。中英文结尾都不要句号。返回结构：{"items":[{"index":0,"en":"校正英文","zh":"自然中文","speaker":""}]}`;
const context = { title, channel, description };

for (let start = 0; start < cues.length; start += 20) {
  const indices = Array.from({ length: Math.min(20, cues.length - start) }, (_, offset) => start + offset);
  let missing = [...indices];
  for (let attempt = 0; attempt < 3 && missing.length; attempt += 1) {
    const transcript = missing.map((index) => ({ index, english: cues[index].sourceText }));
    const nearby = cues.slice(Math.max(0, start - 3), Math.min(cues.length, start + indices.length + 3))
      .map((cue, offset) => ({ index: Math.max(0, start - 3) + offset, english: cue.sourceText }));
    const response = await requestDeepSeek(`${apiBase}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 5000,
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify({ targetIndices: missing, videoContext: context, verifiedTerms, context: nearby, transcript }) },
        ],
      }),
    });
    const completion = await response.json();
    const parsed = JSON.parse(completion.choices?.[0]?.message?.content || "{}");
    for (const item of parsed.items || []) {
      if (!indices.includes(item.index) || !item.zh?.trim()) continue;
      cues[item.index].sourceText = stripStop(item.en?.trim() || cues[item.index].sourceText);
      cues[item.index].targetText = stripStop(item.zh.trim());
      cues[item.index].speaker = item.speaker?.trim() || "";
    }
    saveTranslationCache();
    missing = missing.filter((index) => !cues[index].targetText);
  }
  if (missing.length) throw new Error(`DeepSeek 缺少字幕：${missing.map((value) => value + 1).join("、")}`);
}

async function requestDeepSeek(url, options) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      const detail = (await response.text()).slice(0, 300);
      if (response.status !== 429 && response.status < 500) throw new Error(`DeepSeek HTTP ${response.status}: ${detail}`);
      lastError = new Error(`DeepSeek HTTP ${response.status}: ${detail}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1_500 * (attempt + 1)));
  }
  throw lastError || new Error("DeepSeek 请求失败");
}

function stripStop(value) {
  return value.trim().replace(/[.。．]+(["'”’）)\]】》〉」』]*)$/u, "$1").trim();
}

function sqlText(value) {
  return `CAST(X'${Buffer.from(String(value), "utf8").toString("hex")}' AS TEXT)`;
}

function sqlite(sql) {
  const result = spawnSync("sqlite3", [dbPath], { input: sql, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || "SQLite 写入失败");
  return result.stdout.trim();
}

sqlite("CREATE TABLE IF NOT EXISTS project_contexts (project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE, source_context TEXT NOT NULL DEFAULT '{}');");
const existingId = sqlite(`SELECT id FROM projects WHERE video_path=${sqlText(videoPath)} LIMIT 1;`);
const projectId = forcedProjectId || existingId || randomUUID();
const now = new Date().toISOString();
const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", videoPath], { encoding: "utf8", windowsHide: true });
const durationMs = Math.round((Number(probe.stdout.trim()) || 0) * 1000);
const sourceContext = JSON.stringify({ title, channel, description, verifiedTerms });
const statements = [
  "BEGIN IMMEDIATE;",
  `INSERT INTO projects (id,name,video_path,duration_ms,created_at,updated_at,subtitle_style) VALUES (${sqlText(projectId)},${sqlText(title)},${sqlText(videoPath)},${durationMs},${sqlText(now)},${sqlText(now)},${sqlText(JSON.stringify(DEFAULT_SUBTITLE_STYLE))}) ON CONFLICT(id) DO UPDATE SET name=excluded.name,video_path=excluded.video_path,duration_ms=excluded.duration_ms,updated_at=excluded.updated_at;`,
  `INSERT INTO project_contexts (project_id,source_context) VALUES (${sqlText(projectId)},${sqlText(sourceContext)}) ON CONFLICT(project_id) DO UPDATE SET source_context=excluded.source_context;`,
  `DELETE FROM cues WHERE project_id=${sqlText(projectId)};`,
];
cues.forEach((cue, position) => statements.push(
  `INSERT INTO cues (id,project_id,position,start_ms,end_ms,speaker,source_text,target_text,status,updated_at,subtitle_style) VALUES (${sqlText(randomUUID())},${sqlText(projectId)},${position},${Math.round(cue.startMs)},${Math.round(cue.endMs)},${sqlText(cue.speaker || "")},${sqlText(stripStop(cue.sourceText))},${sqlText(stripStop(cue.targetText))},'draft',${sqlText(now)},'{}');`,
));
statements.push("COMMIT;");
sqlite(statements.join("\n"));
process.stdout.write(JSON.stringify({ projectId, cueCount: cues.length, durationMs, corrected: corrections }));
