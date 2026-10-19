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
// DeepSeek is the quality path and requires a key. Set VIDEO_SUBS_TRANSLATOR=mymemory
// to opt back into the key-free fallback, or deepseek to force it.
const translationProvider = process.env.VIDEO_SUBS_TRANSLATOR || (apiKey ? "deepseek" : "mymemory");
if (!["deepseek", "mymemory"].includes(translationProvider)) throw new Error(`未知翻译通道：${translationProvider}`);
if (translationProvider === "deepseek" && !apiKey) throw new Error("DeepSeek 翻译需要 DEEPSEEK_API_KEY");
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
const protectedTerms = parseList(process.env.VIDEO_SUBS_PROTECTED_TERMS_JSON || "[]")
  .map((value) => String(value).trim())
  .filter(Boolean)
  .toSorted((left, right) => right.length - left.length);
const localGroupEndCues = parseList(process.env.VIDEO_SUBS_GROUP_END_CUES || "[]")
  .map(Number)
  .filter(Number.isInteger);

const tracks = [{ language: "en-orig", content: readFileSync(srtPath, "utf8") }];
let cues = buildBilingualCues(tracks).map((cue) => {
  let sourceText = cue.sourceText;
  for (const [wrong, correct] of Object.entries(corrections)) sourceText = sourceText.replaceAll(wrong, correct);
  return { ...cue, sourceText };
});

// Recover complete semantic sentences before translation. Caption providers
// optimize their blocks for display timing, so a grammatical sentence is often
// split across several cues. Translating those fragments independently can
// change the meaning. The compact grouping plan covers every original cue once;
// source words are then joined locally so the model cannot omit or reorder text.
cues = await regroupSemanticSentences(cues);

// Persist successful translation batches beside the source SRT. Long podcast
// imports can then resume after a transient API disconnect or app interruption.
const translationSignature = createHash("sha256").update(JSON.stringify({
  semanticGroupingVersion: 5,
  title, channel, description, verifiedTerms, corrections, translationProvider, protectedTerms,
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

async function regroupSemanticSentences(inputCues) {
  if (inputCues.length < 2) return inputCues;
  const semanticTokens = [];
  inputCues.forEach((cue) => {
    const parts = cue.sourceText.match(/\S+/g) || [];
    const span = Math.max(300, cue.endMs - cue.startMs);
    parts.forEach((text, offset) => semanticTokens.push({
      text,
      speaker: cue.speaker || "",
      startMs: Math.round(cue.startMs + (span * offset) / Math.max(1, parts.length)),
      endMs: Math.round(cue.startMs + (span * (offset + 1)) / Math.max(1, parts.length)),
    }));
  });
  if (semanticTokens.length < 2) return inputCues;
  const groupingSignature = createHash("sha256").update(JSON.stringify({
    version: 5,
    title,
    channel,
    source: inputCues.map((cue) => ({
      startMs: cue.startMs,
      endMs: cue.endMs,
      speaker: cue.speaker,
      text: cue.sourceText,
    })),
  })).digest("hex").slice(0, 16);
  const groupingCachePath = `${srtPath}.${groupingSignature}.semantic-groups.json`;
  let groups = [];
  if (existsSync(groupingCachePath)) {
    try {
      groups = JSON.parse(readFileSync(groupingCachePath, "utf8")).groups || [];
    } catch { /* Rebuild an incomplete grouping cache. */ }
  }

  let tokenCursor = 0;
  const transcript = inputCues.map((cue, index) => {
    const parts = cue.sourceText.match(/\S+/g) || [];
    const startToken = tokenCursor;
    tokenCursor += parts.length;
    return {
      sourceCue: index,
      speaker: cue.speaker || "",
      startMs: Math.round(cue.startMs),
      endMs: Math.round(cue.endMs),
      gapAfterMs: Math.max(0, Math.round((inputCues[index + 1]?.startMs ?? cue.endMs) - cue.endMs)),
      startToken,
      endToken: tokenCursor - 1,
      text: parts.map((text, offset) => `${startToken + offset}:${text}`).join(" "),
    };
  });
  const validPlan = (candidate) => {
    if (!Array.isArray(candidate) || !candidate.length) return false;
    let expected = 0;
    for (const group of candidate) {
      if (!Number.isInteger(group?.start) || !Number.isInteger(group?.end)) return false;
      if (group.start !== expected || group.end < group.start || group.end >= semanticTokens.length) return false;
      const speakers = new Set(semanticTokens.slice(group.start, group.end + 1).map((token) => token.speaker).filter(Boolean));
      if (speakers.size > 1) return false;
      expected = group.end + 1;
    }
    return expected === semanticTokens.length;
  };
  const groupsFromEnds = (ends) => {
    if (!Array.isArray(ends)) return [];
    const finalToken = semanticTokens.length - 1;
    const normalizedEnds = ends
      .map((end) => Number(end))
      .filter((end, index, values) => Number.isInteger(end)
        && end >= 0
        && end <= finalToken
        && (index === 0 || end > values[index - 1]));
    // A truncated model response can omit only the terminal boundary. Adding it
    // restores contiguous coverage without changing, dropping, or reordering text.
    if (normalizedEnds.length && normalizedEnds.at(-1) !== finalToken) normalizedEnds.push(finalToken);
    let start = 0;
    return normalizedEnds.map((end) => {
      const group = { start, end };
      start = end + 1;
      return group;
    });
  };
  const enforceSpeakerBoundaries = (candidate) => {
    if (!Array.isArray(candidate)) return [];
    const repaired = [];
    for (const group of candidate) {
      if (!Number.isInteger(group?.start) || !Number.isInteger(group?.end) || group.end < group.start) {
        return [];
      }
      let start = group.start;
      for (let index = group.start + 1; index <= group.end; index += 1) {
        const before = semanticTokens[index - 1]?.speaker || "";
        const after = semanticTokens[index]?.speaker || "";
        if (before && after && before !== after) {
          repaired.push({ start, end: index - 1 });
          start = index;
        }
      }
      repaired.push({ start, end: group.end });
    }
    return repaired;
  };
  const mergeDanglingGroups = (candidate) => {
    const danglingEnd = /(?:\b(?:a|an|the|and|or|but|because|if|when|while|although|though|unless|until|since|so|than|as|that|which|who|whom|whose|what|where|why|how|to|of|in|on|at|by|for|from|with|into|about|after|before|like)|\b(?:he|she|they|i|we|you)\s+(?:said|says|asked|asks|meant|means))$/i;
    const normalizedTail = (group) => semanticTokens
      .slice(Math.max(group.start, group.end - 4), group.end + 1)
      .map((token) => token.text)
      .join(" ")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}' ]/gu, "")
      .trim();
    const repaired = [];
    for (const group of candidate) {
      const previous = repaired.at(-1);
      const previousSpeaker = previous ? semanticTokens[previous.start]?.speaker || "" : "";
      const currentSpeaker = semanticTokens[group.start]?.speaker || "";
      if (previous
        && (!previousSpeaker || !currentSpeaker || previousSpeaker === currentSpeaker)
        && semanticTokens.slice(previous.start, group.end + 1)
          .reduce((total, item) => total + item.text.length + 1, 0) <= 120
        && danglingEnd.test(normalizedTail(previous))) {
        previous.end = group.end;
      } else {
        repaired.push({ ...group });
      }
    }
    return repaired;
  };
  const deterministicGroups = () => {
    const fallback = [];
    let start = 0;
    for (let index = 0; index < semanticTokens.length; index += 1) {
      const token = semanticTokens[index];
      const next = semanticTokens[index + 1];
      const speakerChanges = Boolean(next && token.speaker && next.speaker && token.speaker !== next.speaker);
      const elapsedMs = token.endMs - semanticTokens[start].startMs;
      const characterCount = semanticTokens.slice(start, index + 1)
        .reduce((total, item) => total + item.text.length + 1, 0);
      const sentenceEnds = /[.!?]["')\]]*$/u.test(token.text);
      const clauseEnds = /[,;:]["')\]]*$/u.test(token.text);
      const naturalLengthBreak = characterCount >= 80 && (clauseEnds || /\b(?:and|but|so|because|when|while|then)$/iu.test(token.text));
      if (!next || speakerChanges || sentenceEnds || naturalLengthBreak || characterCount >= 112 || (elapsedMs >= 5_500 && clauseEnds) || elapsedMs >= 8_500) {
        fallback.push({ start, end: index });
        start = index + 1;
      }
    }
    return enforceSpeakerBoundaries(fallback);
  };

  if (translationProvider === "mymemory" && localGroupEndCues.length) {
    groups = groupsFromEnds(localGroupEndCues.map((cueIndex) => transcript[cueIndex]?.endToken));
    if (!validPlan(groups)) throw new Error("本地语义分句未能完整、连续地覆盖全部字幕");
  }

  if (!validPlan(groups)) {
    groups = [];
    const groupingPrompt = `你是英文口语字幕的语义分句编辑。输入是按时间排序的完整视频字幕，每个英文词前的数字是该词在全片中的 token index。只输出紧凑 JSON，格式为 {"ends":[8,17,31]}，数组中的每个数字是一个完整语义单元最后一个词的 token index；第一个单元从 token 0 开始，下一个从前一个数字加 1 开始。你可以在原 sourceCue 内部断句，也可以跨 sourceCue 合并。ends 必须严格递增，最后一个数字必须等于全片最后一个 token index，不能遗漏、重复、倒序或跨说话人。绝不能拆开专名、否定、固定搭配、动词与短宾语。长句必须在真实从句边界拆成可独立理解的显示块；后一块若依赖前文，可保留必要的主语或承接关系，但不能改写原词。不要仅因原字幕换块就断句。优先控制在 2.5–6 秒、45–90 个英文字符，硬上限约 8.5 秒或 115 个字符；只有没有任何安全从句边界时才可略超。目标是在 1920×1080 画面中每种语言最多两行。不要输出解释。`;
    for (let attempt = 0; translationProvider !== "mymemory" && attempt < 3 && !validPlan(groups); attempt += 1) {
      try {
        const completion = await requestDeepSeekJson(`${apiBase}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            temperature: 0,
            max_tokens: 8_000,
            thinking: { type: "disabled" },
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: groupingPrompt },
              { role: "user", content: JSON.stringify({ videoContext: { title, channel, description }, transcript }) },
            ],
          }),
        });
        const parsedPlan = JSON.parse(completion.choices?.[0]?.message?.content || "{}");
        groups = enforceSpeakerBoundaries(groupsFromEnds(parsedPlan.ends));
        if (!validPlan(groups)) groups = enforceSpeakerBoundaries(parsedPlan.groups || []);
      } catch { groups = []; }
    }
    if (!validPlan(groups)) groups = deterministicGroups();
    if (!validPlan(groups)) throw new Error("语义分句计划未能完整、连续地覆盖全部字幕");
    writeFileSync(groupingCachePath, `${JSON.stringify({ version: 5, groups })}\n`, "utf8");
  }
  groups = mergeDanglingGroups(groups);
  if (!validPlan(groups)) throw new Error("语法闭合修复破坏了字幕连续覆盖");

  return groups.map((group, position) => {
    const members = semanticTokens.slice(group.start, group.end + 1);
    const first = members[0];
    const last = members.at(-1);
    return {
      ...first,
      id: randomUUID(),
      position,
      startMs: first.startMs,
      endMs: last.endMs,
      speaker: first.speaker || "",
      sourceText: stripStop(members.map((token) => token.text).join(" ").replace(/\s+([,.;:!?，。！？；：])/g, "$1")),
      targetText: "",
    };
  });
}

const systemPrompt = `你是专业的中英双语口语视频字幕编辑，只返回 JSON。结合视频标题、频道、简介、verifiedTerms 和前后字幕，先校正英文自动字幕里的高置信度人名、地名、队名、品牌和专业术语，再翻译成自然简洁的简体中文口语字幕。en 只能修正明确的转录错误、大小写和专名拼写，禁止改写普通口语；证据不足时保留原文。zh 要符合中国人口头表达，可省略无意义填充词和无意义重复，但不得丢失事实、否定、数字和观点。经过上下文或检索确认的英文人名，在 zh 中必须直接保留校正后的拉丁字母完整拼写，禁止音译、意译或替换成中文姓名；例如 Dylan Cease 在中文字幕中仍写作 Dylan Cease。每个 index 必须返回一次，不能合并、拆分、错序或省略。中英文结尾都不要句号。返回结构：{"items":[{"index":0,"en":"校正英文","zh":"自然中文","speaker":""}]}`;
const context = { title, channel, description };

if (translationProvider === "mymemory") {
  await translateWithMyMemory(cues);
} else {
for (let start = 0; start < cues.length; start += 20) {
  const indices = Array.from({ length: Math.min(20, cues.length - start) }, (_, offset) => start + offset);
  let missing = [...indices];
  for (let attempt = 0; attempt < 3 && missing.length; attempt += 1) {
    const transcript = missing.map((index) => ({ index, english: cues[index].sourceText }));
    const nearby = cues.slice(Math.max(0, start - 3), Math.min(cues.length, start + indices.length + 3))
      .map((cue, offset) => ({ index: Math.max(0, start - 3) + offset, english: cue.sourceText }));
    let parsed = {};
    try {
      const completion = await requestDeepSeekJson(`${apiBase}/chat/completions`, {
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
      parsed = JSON.parse(completion.choices?.[0]?.message?.content || "{}");
    } catch { parsed = {}; }
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

await repairDanglingChinese(cues);
}
saveTranslationCache();

async function translateWithMyMemory(items) {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      if (items[index].targetText) continue;
      items[index].targetText = stripStop(await requestMyMemoryTranslation(items[index].sourceText));
      saveTranslationCache();
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, items.length) }, worker));
}

async function requestMyMemoryTranslation(sourceText) {
  let protectedText = sourceText;
  const replacements = [];
  protectedTerms.forEach((term, index) => {
    if (!protectedText.includes(term)) return;
    const placeholder = `__NAME_${index}__`;
    protectedText = protectedText.replaceAll(term, placeholder);
    replacements.push({ placeholder, term });
  });
  const url = new URL("https://api.mymemory.translated.net/get");
  url.search = new URLSearchParams({ q: protectedText, langpair: "en|zh-CN", mt: "1" }).toString();
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const body = process.platform === "win32"
        ? requestJsonViaPowerShell(url)
        : await requestJsonViaFetch(url);
      if (body?.responseStatus !== 200 || body?.quotaFinished) throw new Error(body?.responseDetails || "MyMemory 免费额度已用完");
      let translated = String(body?.responseData?.translatedText || "").trim();
      if (!translated) throw new Error("MyMemory 返回空结果");
      for (const { placeholder, term } of replacements) translated = translated.replaceAll(placeholder, term);
      return translated;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
    }
  }
  throw lastError || new Error("MyMemory 请求失败");
}

function requestJsonViaPowerShell(url) {
  const result = spawnSync("curl.exe", ["-sS", "-L", "--max-time", "30", url.toString()], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || "翻译接口 curl 请求失败");
  return JSON.parse(result.stdout.trim());
}

async function requestJsonViaFetch(url) {
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`翻译接口 HTTP ${response.status}`);
  return response.json();
}

async function repairDanglingChinese(items) {
  const danglingChinese = /(?:比如|例如|因为|所以|但是|而且|以及|然后|如果|虽然|除非|直到|为了|关于|他说|她说|他们说|这意味着|也就是)$/u;
  let suspicious = items
    .map((cue, index) => ({ cue, index }))
    .filter(({ cue }) => danglingChinese.test(cue.targetText.trim()))
    .map(({ index }) => index);
  if (!suspicious.length) return;

  const repairPrompt = `你是中文字幕终审，只返回 JSON。输入中的 targetIndices 是结尾存在悬空连接词、引述词或未闭合结构的中文字幕。结合相邻英文和中文字幕，只重写这些 index 的 zh，使每条在当前说话人边界内语意完整、自然、简洁；如果下一条是另一位说话人的引语，要把本条改写成完整的引述背景，不要以“他说”“比如”等词悬空。不能合并、拆分、漏掉事实、否定、数字或专名，不要改英文。返回 {"items":[{"index":1,"zh":"修复后的中文"}]}，结尾不要句号。`;
  for (let attempt = 0; attempt < 3 && suspicious.length; attempt += 1) {
    for (let batchStart = 0; batchStart < suspicious.length; batchStart += 20) {
      const batch = suspicious.slice(batchStart, batchStart + 20);
      const contextIndices = [...new Set(batch.flatMap((index) => [index - 2, index - 1, index, index + 1, index + 2]))]
        .filter((index) => index >= 0 && index < items.length)
        .toSorted((left, right) => left - right);
      const contextItems = contextIndices.map((index) => ({
        index,
        en: items[index].sourceText,
        zh: items[index].targetText,
      }));
      try {
        const completion = await requestDeepSeekJson(`${apiBase}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            temperature: 0,
            max_tokens: 3_000,
            thinking: { type: "disabled" },
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: repairPrompt },
              { role: "user", content: JSON.stringify({ targetIndices: batch, context: contextItems }) },
            ],
          }),
        });
        const parsed = JSON.parse(completion.choices?.[0]?.message?.content || "{}");
        for (const item of parsed.items || []) {
          if (!batch.includes(item.index) || !item.zh?.trim()) continue;
          items[item.index].targetText = stripStop(item.zh.trim());
        }
      } catch { /* Retry the same suspicious items. */ }
    }
    suspicious = suspicious.filter((index) => danglingChinese.test(items[index].targetText.trim()));
  }
  if (suspicious.length) throw new Error(`中文字幕仍有未闭合语义：${suspicious.map((value) => value + 1).join("、")}`);
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

async function requestDeepSeekJson(url, options) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await requestDeepSeek(url, options);
      const body = await response.text();
      return JSON.parse(body);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1_500 * (attempt + 1)));
  }
  throw lastError || new Error("DeepSeek 响应读取失败");
}

function stripStop(value) {
  return value.trim().replace(/[.。．]+(["'”’）)\]】》〉」』]*)$/u, "$1").trim();
}

// Latin proper names are considerably narrower than CJK glyphs, so a raw
// character count rejects readable bilingual cues such as
// "如果球从Jarred Vanderbilt身后传给LeBron James". Count each Latin character
// as roughly half a CJK glyph for the display-length gate.
function displayLength(value) {
  return [...String(value)].reduce((total, character) => total + (/^[\u0000-\u00ff]$/u.test(character) ? 0.55 : 1), 0);
}

function sqlText(value) {
  return `CAST(X'${Buffer.from(String(value), "utf8").toString("hex")}' AS TEXT)`;
}

function sqlite(sql) {
  const result = spawnSync("sqlite3", ["-bail", dbPath], { input: `.timeout 10000\nPRAGMA foreign_keys=ON;\n${sql}`, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || "SQLite 写入失败");
  return result.stdout.trim();
}

sqlite("CREATE TABLE IF NOT EXISTS project_contexts (project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE, source_context TEXT NOT NULL DEFAULT '{}');");
const existingId = sqlite(`SELECT id FROM projects WHERE video_path=${sqlText(videoPath)} LIMIT 1;`);
const projectId = forcedProjectId || existingId || randomUUID();
const now = new Date().toISOString();
const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", videoPath], { encoding: "utf8", windowsHide: true });
const durationMs = Math.round((Number(probe.stdout.trim()) || 0) * 1000);
if (durationMs > 0) cues = cues.map((cue) => {
  const endMs = Math.min(durationMs, Math.max(250, Math.round(cue.endMs)));
  const startMs = Math.min(Math.round(cue.startMs), endMs - 250);
  return { ...cue, startMs: Math.max(0, startMs), endMs };
});
for (let index = 0; index < cues.length - 1; index += 1) {
  const cue = cues[index];
  const next = cues[index + 1];
  const gap = Math.max(0, next.startMs - cue.endMs);
  if (gap <= 1_500) cue.endMs = Math.max(cue.startMs + 250, next.startMs);
  else cue.endMs = Math.max(cue.startMs + 250, Math.min(next.startMs - 600, cue.endMs + 300));
}
const qualityProblems = cues.flatMap((cue, index) => {
  const problems = [];
  const duration = cue.endMs - cue.startMs;
  if (!cue.sourceText.trim() || !cue.targetText.trim()) problems.push("缺少文本");
  if (duration > 9_500) problems.push(`时长 ${duration}ms`);
  if (cue.sourceText.length > 125) problems.push(`英文 ${cue.sourceText.length} 字符`);
  if (displayLength(cue.targetText) > 46) problems.push(`中文宽度 ${displayLength(cue.targetText).toFixed(1)}`);
  return problems.length ? [`${index + 1}(${problems.join("、")})`] : [];
});
if (qualityProblems.length) throw new Error(`字幕显示块未通过长度质量门：${qualityProblems.join("；")}`);
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
