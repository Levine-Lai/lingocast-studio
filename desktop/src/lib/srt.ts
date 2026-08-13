import type { DownloadedSubtitleTrack, SubtitleCue } from "../types";

const TIMING = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})(?:\s+.*)?$/;
const SENTENCE_BOUNDARY = "\uE000";

function timestampToMs(groups: string[]) {
  const [hours, minutes, seconds, millis] = groups.map(Number);
  return ((hours * 60 * 60 + minutes * 60 + seconds) * 1000) + millis;
}

function srtTimestamp(milliseconds: number) {
  const safe = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const millis = safe % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

export function sanitizeSubtitleInput(value: string) {
  return value
    .replace(/<[^>]+>/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replace(/\[[^\]]*]/g, " ")
    .replace(/\((?:music|applause|laughter|laughs?|cheering|silence|inaudible)[^)]*\)/gi, " ")
    .replace(/[♪♫♬]+/g, " ")
    .split("\n")
    .map((line) => line
      .replace(/^\s*>>+\s*/g, "")
      .replace(/[ \t]+/g, " "))
    .join("\n");
}

export function stripSubtitleTerminalFullStops(value: string) {
  const trimmed = value.trimEnd();
  const closingMarks = trimmed.match(/["'”’）)\]】》〉」』]+$/u)?.[0] ?? "";
  const body = closingMarks ? trimmed.slice(0, -closingMarks.length).trimEnd() : trimmed;
  return `${body.replace(/[.,，。．]+$/u, "").trimEnd()}${closingMarks}`;
}

export function normalizeSubtitleEditorText(value: string) {
  return sanitizeSubtitleInput(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function sanitizeSubtitleText(value: string) {
  return stripSubtitleTerminalFullStops(normalizeSubtitleEditorText(value));
}

export function splitSubtitleText(text: string, ratio: number) {
  const value = text.trim();
  if (value.length < 2) return [value, ""] as const;
  const target = Math.max(1, Math.min(value.length - 1, Math.round(value.length * ratio)));
  const boundaries: number[] = [];
  for (let index = 1; index < value.length; index += 1) {
    if (/\s/.test(value[index]) || /[,，。.!！？?；;：:、]/.test(value[index - 1])) boundaries.push(index);
  }
  const splitAt = boundaries.length
    ? boundaries.reduce((best, candidate) => Math.abs(candidate - target) < Math.abs(best - target) ? candidate : best)
    : target;
  return [value.slice(0, splitAt).trim(), value.slice(splitAt).trim()] as const;
}

function parseSrtContent(input: string, preserveSentenceBoundaries: boolean): SubtitleCue[] {
  const normalized = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];

  const cues: SubtitleCue[] = [];
  let speakerSequence = 0;
  let currentSpeaker = "";
  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((line) => TIMING.test(line.trim()));
    if (timingIndex < 0) continue;
    const match = lines[timingIndex].trim().match(TIMING);
    if (!match) continue;
    let rawText = lines.slice(timingIndex + 1).join("\n");
    const speakerMarker = rawText.match(/^\s*>>+\s*(?:([^:\n]{1,32}):\s*)?/);
    if (speakerMarker) {
      const namedSpeaker = speakerMarker[1]?.trim();
      currentSpeaker = namedSpeaker || `Speaker ${++speakerSequence}`;
      rawText = rawText.slice(speakerMarker[0].length);
    }
    const preparedText = preserveSentenceBoundaries
      ? rawText.replace(/([。.．]+)(?=\s|$)/g, `$1${SENTENCE_BOUNDARY}`)
      : rawText;
    const sourceText = sanitizeSubtitleText(preparedText);
    const startMs = timestampToMs(match.slice(1, 5));
    const endMs = timestampToMs(match.slice(5, 9));
    cues.push({
      id: crypto.randomUUID(),
      position: cues.length,
      startMs,
      endMs: Math.max(startMs + 100, endMs),
      speaker: currentSpeaker,
      sourceText,
      targetText: "",
      status: "draft",
    });
  }
  return cues;
}

export function parseSrt(input: string): SubtitleCue[] {
  return parseSrtContent(input, false);
}

function languageScore(language: string, target: "en" | "zh") {
  const normalized = language.toLowerCase();
  if (target === "en") {
    if (normalized === "en-orig") return 0;
    if (normalized === "en") return 1;
    if (normalized.startsWith("en-")) return 2;
    return 100;
  }
  if (normalized === "zh-hans" || normalized === "zh-cn") return 0;
  if (normalized === "zh-hant" || normalized === "zh-tw") return 1;
  if (normalized.startsWith("zh")) return 2;
  return 100;
}

function chooseTrack(tracks: DownloadedSubtitleTrack[], target: "en" | "zh") {
  return tracks
    .map((track) => ({ track, score: languageScore(track.language, target) }))
    .filter(({ score }) => score < 100)
    .toSorted((left, right) => left.score - right.score)[0]?.track;
}

function bestMatchingText(cue: SubtitleCue, candidates: SubtitleCue[]) {
  let bestText = "";
  let bestOverlap = 0;
  for (const candidate of candidates) {
    const overlap = Math.max(0, Math.min(cue.endMs, candidate.endMs) - Math.max(cue.startMs, candidate.startMs));
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestText = candidate.sourceText;
    }
  }
  return bestText;
}

type TimedToken = {
  text: string;
  startMs: number;
  endMs: number;
  speaker: string;
};

const HARD_SENTENCE_END = new RegExp(`[!?…${SENTENCE_BOUNDARY}](?:["'”’\\])}]+)?$`);
const SOFT_SENTENCE_END = /[,;:，；：](?:["'”’\])}]+)?$/;
export type SubtitleSegmentationConfig = {
  minimumCharacters: number;
  preferredCharacters: number;
  maximumCharacters: number;
  maximumDurationMs: number;
  softPauseMs: number;
  hardPauseMs: number;
  mergePauseMs: number;
};

export const DEFAULT_SUBTITLE_SEGMENTATION: SubtitleSegmentationConfig = {
  minimumCharacters: 28,
  preferredCharacters: 62,
  maximumCharacters: 88,
  maximumDurationMs: 6_500,
  softPauseMs: 360,
  hardPauseMs: 900,
  mergePauseMs: 280,
};

export type SubtitleCorrection = { wrong: string; correct: string };

export function applySubtitleCorrections(cues: SubtitleCue[], corrections: SubtitleCorrection[]) {
  const usable = corrections.filter(({ wrong, correct }) => wrong && correct && wrong !== correct);
  if (!usable.length) return cues;
  return cues.map((cue) => ({
    ...cue,
    sourceText: usable.reduce((text, correction) => text.replaceAll(correction.wrong, correction.correct), cue.sourceText),
  }));
}
const AUTOMATIC_CAPTION_DELAY_MS = 160;
const DANGLING_WORDS = new Set(["a", "an", "and", "as", "at", "because", "but", "for", "from", "if", "in", "of", "on", "or", "the", "that", "to", "when", "while", "with"]);
const CLAUSE_STARTERS = new Set(["although", "and", "because", "before", "but", "even", "however", "if", "now", "otherwise", "since", "so", "then", "though", "unless", "until", "when", "where", "while", "who", "which"]);

function comparableWord(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
}

function repeatedPrefixLength(history: string[], words: string[]) {
  const maximum = Math.min(history.length, words.length);
  for (let length = maximum; length > 0; length -= 1) {
    const historyStart = history.length - length;
    let matches = true;
    for (let index = 0; index < length; index += 1) {
      if (comparableWord(history[historyStart + index]) !== comparableWord(words[index])) {
        matches = false;
        break;
      }
    }
    if (matches) return length;
  }
  return 0;
}

function timedTokens(cues: SubtitleCue[]) {
  const ordered = cues
    .filter((cue) => cue.sourceText.trim())
    .toSorted((left, right) => left.startMs - right.startMs || left.position - right.position);
  const tokens: TimedToken[] = [];
  const spokenHistory: string[] = [];
  let previousCueEnd = -Infinity;
  let previousSpeaker = "";
  ordered.forEach((cue, cueIndex) => {
    const words = cue.sourceText.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    if (!words.length) return;
    if (cue.startMs > previousCueEnd + 300 || (cue.speaker && previousSpeaker && cue.speaker !== previousSpeaker)) {
      spokenHistory.length = 0;
    }
    const repeatedPrefix = repeatedPrefixLength(spokenHistory, words);
    const novelWords = words.slice(repeatedPrefix);
    if (!novelWords.length) return;
    const nextStart = ordered[cueIndex + 1]?.startMs;
    const naturalEnd = typeof nextStart === "number" && nextStart > cue.startMs + 80
      ? Math.min(cue.endMs, nextStart)
      : cue.endMs;
    const windowEnd = Math.max(cue.startMs + words.length * 45, naturalEnd);
    const span = windowEnd - cue.startMs;
    novelWords.forEach((text, novelIndex) => {
      const wordIndex = repeatedPrefix + novelIndex;
      tokens.push({
        text,
        startMs: Math.round(cue.startMs + (span * wordIndex) / words.length),
        endMs: Math.round(cue.startMs + (span * (wordIndex + 1)) / words.length),
        speaker: cue.speaker,
      });
    });
    spokenHistory.push(...novelWords);
    if (spokenHistory.length > 80) spokenHistory.splice(0, spokenHistory.length - 80);
    previousCueEnd = Math.max(previousCueEnd, cue.endMs);
    if (cue.speaker) previousSpeaker = cue.speaker;
  });
  return { ordered, tokens };
}

function tokenText(tokens: TimedToken[]) {
  return tokens.map((token) => token.text).join(" ").replace(/\s+([,.;:!?，。！？；：])/g, "$1").trim();
}

function naturalBreakIndex(tokens: TimedToken[], config: SubtitleSegmentationConfig) {
  if (tokens.length < 2) return -1;
  const totalLength = tokenText(tokens).length;
  let bestIndex = -1;
  let bestScore = -Infinity;
  for (let index = 1; index < tokens.length; index += 1) {
    const before = tokens[index - 1];
    const after = tokens[index];
    const prefixLength = tokenText(tokens.slice(0, index)).length;
    const suffixLength = totalLength - prefixLength;
    if (prefixLength < Math.max(16, config.minimumCharacters - 8)) continue;
    const previousWord = comparableWord(before.text);
    const nextWord = comparableWord(after.text);
    const pause = Math.max(0, after.startMs - before.endMs);
    let score = -Math.abs(prefixLength - config.preferredCharacters);
    if (SOFT_SENTENCE_END.test(before.text)) score += 42;
    if (HARD_SENTENCE_END.test(before.text)) score += 60;
    if (CLAUSE_STARTERS.has(nextWord)) score += 26;
    score += Math.min(30, pause / 20);
    if (DANGLING_WORDS.has(previousWord)) score -= 36;
    if (suffixLength < 12) score -= (12 - suffixLength) * 3;
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }
  if (bestIndex > 0) return bestIndex;
  let fallback = Math.max(1, tokens.length - 1);
  while (fallback > 1 && DANGLING_WORDS.has(comparableWord(tokens[fallback - 1].text))) fallback -= 1;
  return fallback;
}

function splitIntoReadableSegments(
  tokens: TimedToken[],
  config: SubtitleSegmentationConfig = DEFAULT_SUBTITLE_SEGMENTATION,
) {
  const segments: TimedToken[][] = [];
  let current: TimedToken[] = [];

  function emit(count = current.length) {
    const segment = current.slice(0, count);
    if (segment.length) segments.push(segment);
    current = current.slice(count);
  }

  for (const token of tokens) {
    const previousToken = current.at(-1);
    if (previousToken?.speaker && token.speaker && previousToken.speaker !== token.speaker) emit();
    const currentPreviousToken = current.at(-1);
    if (currentPreviousToken) {
      const pause = token.startMs - currentPreviousToken.endMs;
      const currentText = tokenText(current);
      const currentDuration = currentPreviousToken.endMs - current[0].startMs;
      const meaningfulSoftBoundary = SOFT_SENTENCE_END.test(currentPreviousToken.text)
        || HARD_SENTENCE_END.test(currentPreviousToken.text)
        || CLAUSE_STARTERS.has(comparableWord(token.text));
      if (pause >= config.hardPauseMs
        || (pause >= config.softPauseMs
          && (currentText.length >= config.minimumCharacters
            || currentDuration >= 1_500
            || meaningfulSoftBoundary))) emit();
    }
    current.push(token);
    const text = tokenText(current);
    const duration = current.at(-1)!.endMs - current[0].startMs;
    if (HARD_SENTENCE_END.test(token.text) && (text.length >= 18 || duration >= 1_200)) {
      emit();
      continue;
    }
    if (text.length <= config.maximumCharacters && duration <= config.maximumDurationMs) continue;
    emit(naturalBreakIndex(current, config));
  }
  emit();

  return segments.reduce<TimedToken[][]>((result, segment) => {
    const text = tokenText(segment);
    const duration = segment.at(-1)!.endMs - segment[0].startMs;
    const previous = result.at(-1);
    if (previous && (text.length < config.minimumCharacters || duration < 950)) {
      const combined = [...previous, ...segment];
      const pause = segment[0].startMs - previous.at(-1)!.endMs;
      const combinedDuration = combined.at(-1)!.endMs - combined[0].startMs;
      const previousSpeaker = previous.find((token) => token.speaker)?.speaker ?? "";
      const segmentSpeaker = segment.find((token) => token.speaker)?.speaker ?? "";
      const sameSpeaker = !previousSpeaker || !segmentSpeaker || previousSpeaker === segmentSpeaker;
      if (sameSpeaker
        && pause < config.mergePauseMs
        && tokenText(combined).length <= config.maximumCharacters
        && combinedDuration <= config.maximumDurationMs) {
        result[result.length - 1] = combined;
        return result;
      }
    }
    result.push(segment);
    return result;
  }, []);
}

function overlappingValue(
  startMs: number,
  endMs: number,
  candidates: SubtitleCue[],
  read: (cue: SubtitleCue) => string,
) {
  return candidates
    .filter((cue) => Math.min(endMs, cue.endMs) - Math.max(startMs, cue.startMs) > 0)
    .map(read)
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, values) => index === 0 || value !== values[index - 1])
    .join(" ");
}

export function resegmentCues(
  cues: SubtitleCue[],
  config: SubtitleSegmentationConfig = DEFAULT_SUBTITLE_SEGMENTATION,
) {
  const { ordered, tokens } = timedTokens(cues);
  if (!tokens.length) return [];
  const regrouped = splitIntoReadableSegments(tokens, config).map((segment, position) => {
    const startMs = segment[0].startMs;
    const endMs = Math.max(startMs + 300, segment.at(-1)!.endMs);
    const speaker = segment.find((token) => token.speaker.trim())?.speaker
      ?? ordered.find((cue) => cue.startMs < endMs && cue.endMs > startMs && cue.speaker.trim())?.speaker
      ?? "";
    return {
      id: crypto.randomUUID(),
      position,
      startMs,
      endMs,
      speaker,
      sourceText: sanitizeSubtitleText(tokenText(segment).replaceAll(SENTENCE_BOUNDARY, "")),
      targetText: sanitizeSubtitleText(overlappingValue(startMs, endMs, ordered, (cue) => cue.targetText)),
      status: "draft" as const,
    };
  });
  return regrouped.map((cue, index) => {
    const nextStart = regrouped[index + 1]?.startMs;
    if (typeof nextStart !== "number" || cue.endMs <= nextStart) return cue;
    return { ...cue, endMs: Math.max(cue.startMs + 100, nextStart) };
  });
}

function delayAutomaticCues(cues: SubtitleCue[]) {
  return cues.map((cue) => ({
    ...cue,
    startMs: cue.startMs + AUTOMATIC_CAPTION_DELAY_MS,
    endMs: cue.endMs + AUTOMATIC_CAPTION_DELAY_MS,
  }));
}

export function buildBilingualCues(tracks: DownloadedSubtitleTrack[]) {
  const english = chooseTrack(tracks, "en");
  if (!english) return [];
  const sourceCues = resegmentCues(parseSrtContent(english.content, true));
  const chinese = chooseTrack(tracks, "zh");
  if (!chinese) return delayAutomaticCues(sourceCues);
  const targetCues = parseSrt(chinese.content);
  return delayAutomaticCues(sourceCues.map((cue) => ({
    ...cue,
    targetText: overlappingValue(cue.startMs, cue.endMs, targetCues, (candidate) => candidate.sourceText)
      || bestMatchingText(cue, targetCues),
  })));
}

export function renderSrt(cues: SubtitleCue[], bilingual = true) {
  return cues
    .toSorted((a, b) => a.startMs - b.startMs || a.position - b.position)
    .map((cue, index) => {
      const lines = [normalizeSubtitleEditorText(cue.sourceText)];
      if (bilingual && cue.targetText.trim()) lines.push(normalizeSubtitleEditorText(cue.targetText));
      return [
        String(index + 1),
        `${srtTimestamp(cue.startMs)} --> ${srtTimestamp(cue.endMs)}`,
        lines.filter(Boolean).join("\n"),
      ].join("\n");
    })
    .join("\n\n") + "\n";
}
