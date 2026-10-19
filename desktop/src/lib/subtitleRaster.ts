import { normalizeSubtitleStyle, type SubtitleCue, type SubtitleStyle } from "../types";
import { buildSubtitleRenderSegments, type TrackedSubtitleCue } from "./subtitleTracks";

export const SUBTITLE_CANVAS_WIDTH = 1920;
export const SUBTITLE_CANVAS_HEIGHT = 1080;

export type BurnOverlay = {
  startMs: number;
  endMs: number;
  png: Blob;
};

export function buildSubtitleRenderTimeline(cues: SubtitleCue[]) {
  const ordered = cues
    .map((cue, sourceIndex) => ({ cue, sourceIndex }))
    .toSorted((left, right) =>
      left.cue.startMs - right.cue.startMs
      || left.cue.position - right.cue.position
      || left.sourceIndex - right.sourceIndex,
    );
  const timeline: SubtitleCue[] = [];
  let cursorMs = 0;

  for (const { cue } of ordered) {
    const startMs = Math.max(0, cue.startMs);
    const endMs = Math.max(startMs, cue.endMs);
    const visibleStartMs = Math.max(cursorMs, startMs);
    if (endMs <= visibleStartMs) continue;
    timeline.push({ ...cue, startMs: visibleStartMs, endMs });
    cursorMs = endMs;
  }

  return timeline;
}

export function findSubtitleRenderCue(cues: SubtitleCue[], currentMs: number) {
  return buildSubtitleRenderTimeline(cues)
    .find((cue) => cue.startMs <= currentMs && currentMs < cue.endMs);
}

type VisualLine = {
  text: string;
  fontSize: number;
  fontFamily: string;
  color: string;
};

function rgba(hex: string, opacity: number) {
  const value = hex.replace("#", "").padEnd(6, "0").slice(0, 6);
  const number = Number.parseInt(value, 16) || 0;
  return `rgba(${(number >> 16) & 255}, ${(number >> 8) & 255}, ${number & 255}, ${opacity})`;
}

function canvasFont(style: SubtitleStyle, size: number, family: string) {
  return `${style.bold ? 700 : 400} ${size}px "${family.replaceAll('"', "")}"`;
}

const AWKWARD_LINE_END_WORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "from", "if", "in", "of", "on", "or", "the", "to", "with",
]);
const AWKWARD_LINE_START_WORDS = new Set([
  "and", "as", "at", "but", "by", "for", "from", "if", "in", "of", "on", "or", "to", "with",
]);

// Intl.Segmenter handles most Chinese prose well, but it still splits some
// domain terms (for example, `髋臼` becomes `髋` + `臼`). Keep the vocabulary
// that commonly appears in sports-medicine subtitles atomic so a line break
// can never land inside the term.
const PROTECTED_CJK_TERMS = [
  "前交叉韧带", "后交叉韧带", "内侧副韧带", "外侧副韧带", "股骨髋臼关节",
  "肩锁关节", "三角韧带", "跟腱", "半月板", "股骨头", "髋关节", "髋臼",
  "踝关节", "膝关节", "肩关节", "肘关节", "腕关节", "四分卫",
  "锁骨", "肩胛骨", "肱骨", "尺骨", "桡骨", "股骨", "胫骨", "腓骨", "距骨",
].toSorted((left, right) => right.length - left.length);

const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CLOSING_PUNCTUATION = /^[，。！？、；：,.!?;:）】》〉」』”’％%…]+$/u;
const OPENING_PUNCTUATION = /^[（【《〈「『“‘]+$/u;

function mixedCjkTokens(text: string) {
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
  const pieces: Array<{ text: string; gapBefore: boolean }> = [];
  let cursor = 0;
  let gapBefore = false;

  while (cursor < text.length) {
    const whitespace = text.slice(cursor).match(/^\s+/u)?.[0];
    if (whitespace) {
      gapBefore = true;
      cursor += whitespace.length;
      continue;
    }

    const protectedTerm = PROTECTED_CJK_TERMS.find((term) => text.startsWith(term, cursor));
    const segment = protectedTerm
      ?? segmenter.segment(text.slice(cursor))[Symbol.iterator]().next().value?.segment
      ?? Array.from(text.slice(cursor))[0];
    if (!segment) break;
    pieces.push({ text: segment, gapBefore });
    gapBefore = false;
    cursor += segment.length;
  }

  const tokens: string[] = [];
  let opening = "";
  for (const piece of pieces) {
    if (CLOSING_PUNCTUATION.test(piece.text) && tokens.length) {
      tokens[tokens.length - 1] += piece.text;
      continue;
    }
    if (OPENING_PUNCTUATION.test(piece.text)) {
      opening += piece.text;
      continue;
    }
    const gap = piece.gapBefore && tokens.length ? " " : "";
    tokens.push(`${gap}${opening}${piece.text}`);
    opening = "";
  }
  if (opening && tokens.length) tokens[tokens.length - 1] += opening;
  return tokens;
}

function wrapTokens(text: string) {
  if (CJK_CHARACTER.test(text)) {
    return { tokens: mixedCjkTokens(text), separator: "" };
  }
  const usesWordSpacing = /\s/.test(text.trim());
  return {
    tokens: usesWordSpacing ? text.trim().split(/\s+/).filter(Boolean) : Array.from(text.trim()),
    separator: usesWordSpacing ? " " : "",
  };
}

function edgeWord(value: string) {
  return value.toLowerCase().replace(/[^\p{L}']/gu, "");
}

/** Finds the least-ragged partition while keeping the minimum possible line count. */
export function balanceSubtitleLines(text: string, maxWidth: number, measure: (value: string) => number) {
  const trimmed = text.trim();
  if (!trimmed || measure(trimmed) <= maxWidth) return [trimmed];
  const { tokens, separator } = wrapTokens(trimmed);
  if (tokens.length < 2) return [trimmed];
  const value = (start: number, end: number) => tokens.slice(start, end).join(separator).trim();

  const greedy: string[] = [];
  let start = 0;
  while (start < tokens.length) {
    let end = start + 1;
    while (end < tokens.length && measure(value(start, end + 1)) <= maxWidth) end += 1;
    greedy.push(value(start, end));
    start = end;
  }
  const lineCount = greedy.length;
  if (lineCount <= 1) return greedy;

  const targetWidth = measure(trimmed) / lineCount;
  const memo = new Map<string, { score: number; lines: string[] } | null>();

  function solve(tokenIndex: number, lineIndex: number): { score: number; lines: string[] } | null {
    const key = `${tokenIndex}:${lineIndex}`;
    if (memo.has(key)) return memo.get(key) ?? null;
    const linesRemaining = lineCount - lineIndex;
    if (linesRemaining === 1) {
      const line = value(tokenIndex, tokens.length);
      const width = measure(line);
      const result = width <= maxWidth ? { score: (width - targetWidth) ** 2, lines: [line] } : null;
      memo.set(key, result);
      return result;
    }

    let best: { score: number; lines: string[] } | null = null;
    const latestEnd = tokens.length - (linesRemaining - 1);
    for (let end = tokenIndex + 1; end <= latestEnd; end += 1) {
      const line = value(tokenIndex, end);
      const width = measure(line);
      if (width > maxWidth) break;
      const rest = solve(end, lineIndex + 1);
      if (!rest) continue;
      const lastWord = edgeWord(tokens[end - 1]);
      const nextWord = edgeWord(tokens[end] ?? "");
      const awkwardBoundary = separator && (AWKWARD_LINE_END_WORDS.has(lastWord) || AWKWARD_LINE_START_WORDS.has(nextWord));
      const edgePenalty = awkwardBoundary ? maxWidth ** 2 : 0;
      const score = (width - targetWidth) ** 2 + edgePenalty + rest.score;
      if (!best || score < best.score) best = { score, lines: [line, ...rest.lines] };
    }
    memo.set(key, best);
    return best;
  }

  return solve(0, 0)?.lines ?? greedy;
}

function wrapLine(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  return balanceSubtitleLines(text, maxWidth, (value) => context.measureText(value).width);
}

function visualLines(
  context: CanvasRenderingContext2D,
  text: string,
  fontSize: number,
  fontFamily: string,
  color: string,
  style: SubtitleStyle,
) {
  const paragraphs = text.replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
  let fittedSize = fontSize;
  let lines: string[] = [];
  do {
    context.font = canvasFont(style, fittedSize, fontFamily);
    lines = paragraphs.flatMap((line) => wrapLine(context, line, SUBTITLE_CANVAS_WIDTH * 0.88));
    if (lines.length <= 2 || fittedSize <= 24) break;
    fittedSize -= 2;
  } while (true);
  return lines.filter(Boolean).map((line) => ({ text: line, fontSize: fittedSize, fontFamily, color }));
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.roundRect(x, y, width, height, safeRadius);
}

const fontLoadCache = new Map<string, Promise<unknown>>();

function loadStyleFonts(style: SubtitleStyle) {
  if (!document.fonts) return Promise.resolve();
  const fonts = [
    canvasFont(style, style.sourceFontSize, style.sourceFontFamily),
    canvasFont(style, style.targetFontSize, style.targetFontFamily),
  ];
  return Promise.all(fonts.map((font) => {
    let loading = fontLoadCache.get(font);
    if (!loading) {
      loading = document.fonts.load(font).catch(() => undefined);
      fontLoadCache.set(font, loading);
    }
    return loading;
  }));
}

function canvasToPng(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("无法生成字幕图层")), "image/png");
  });
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("无法读取字幕图层"));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(blob);
  });
}

function uint32(value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function overlayHeader(startMs: number, endMs: number, pngBytes: number) {
  const bytes = new Uint8Array(20);
  const view = new DataView(bytes.buffer);
  view.setFloat64(0, startMs, true);
  view.setFloat64(8, endMs, true);
  view.setUint32(16, pngBytes, true);
  return bytes;
}

async function packBurnOverlays(overlays: BurnOverlay[], blankPng: Blob) {
  if (typeof CompressionStream === "undefined") {
    throw new Error("当前系统不支持字幕烧录压缩，请更新 Windows WebView2 后重试");
  }
  const parts: BlobPart[] = [
    new Uint8Array([0x4c, 0x43, 0x4f, 0x56, 0x31]), // LCOV1
    uint32(overlays.length),
    uint32(blankPng.size),
    blankPng,
  ];
  for (const overlay of overlays) {
    parts.push(overlayHeader(overlay.startMs, overlay.endMs, overlay.png.size), overlay.png);
  }
  const raw = new Blob(parts, { type: "application/octet-stream" });
  const compressed = await new Response(raw.stream().pipeThrough(new CompressionStream("gzip"))).blob();
  return blobToBase64(compressed);
}

export async function renderSubtitlePng(
  cue: SubtitleCue,
  inputStyle: SubtitleStyle,
  reusableCanvas?: HTMLCanvasElement,
) {
  const style = normalizeSubtitleStyle(inputStyle);
  await loadStyleFonts(style);
  const canvas = reusableCanvas ?? document.createElement("canvas");
  canvas.width = SUBTITLE_CANVAS_WIDTH;
  canvas.height = SUBTITLE_CANVAS_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法初始化字幕画布");

  const sourceLines = cue.sourceText.trim()
    ? visualLines(context, cue.sourceText, style.sourceFontSize, style.sourceFontFamily, style.sourceColor, style)
    : [];
  const targetLines = cue.targetText.trim()
    ? visualLines(context, cue.targetText, style.targetFontSize, style.targetFontFamily, style.targetColor, style)
    : [];
  const groups = [sourceLines, targetLines].filter((lines) => lines.length);
  const allLines = groups.flat();
  if (!allLines.length) return canvasToPng(canvas);

  const groupGap = groups.length > 1 ? style.lineGap : 0;
  const totalHeight = allLines.reduce((sum, line) => sum + line.fontSize * style.lineHeight, 0) + groupGap;
  const centerX = SUBTITLE_CANVAS_WIDTH * style.positionX / 100;
  let lineTop = SUBTITLE_CANVAS_HEIGHT * (1 - style.positionY / 100) - totalHeight;

  for (const [groupIndex, lines] of groups.entries()) {
    for (const line of lines) {
      context.font = canvasFont(style, line.fontSize, line.fontFamily);
      context.textAlign = "center";
      context.textBaseline = "alphabetic";
      const metrics = context.measureText(line.text);
      const ascent = metrics.actualBoundingBoxAscent || line.fontSize * 0.8;
      const descent = metrics.actualBoundingBoxDescent || line.fontSize * 0.2;
      const lineBoxHeight = line.fontSize * style.lineHeight;
      const baseline = lineTop + (lineBoxHeight - ascent - descent) / 2 + ascent;
      const paddingX = line.fontSize * 0.45;
      const paddingTop = line.fontSize * 0.08;
      const paddingBottom = line.fontSize * 0.12;

      if (style.backgroundEnabled) {
        const boxX = centerX - metrics.width / 2 - paddingX;
        const boxY = baseline - ascent - paddingTop;
        const boxWidth = metrics.width + paddingX * 2;
        const boxHeight = ascent + descent + paddingTop + paddingBottom;
        context.save();
        context.fillStyle = rgba(style.backgroundColor, style.backgroundOpacity);
        context.shadowColor = "rgba(0,0,0,.22)";
        context.shadowBlur = 16;
        context.shadowOffsetY = 4;
        roundedRect(context, boxX, boxY, boxWidth, boxHeight, 9);
        context.fill();
        context.restore();
      }

      context.save();
      context.font = canvasFont(style, line.fontSize, line.fontFamily);
      context.textAlign = "center";
      context.textBaseline = "alphabetic";
      context.fillStyle = rgba(line.color, style.textOpacity);
      if (style.shadow) {
        context.shadowColor = "rgba(0,0,0,.92)";
        context.shadowBlur = 9;
        context.shadowOffsetY = 4;
      }
      if (style.outlineWidth > 0) {
        context.lineJoin = "round";
        context.lineWidth = style.outlineWidth * 2;
        context.strokeStyle = rgba(style.outlineColor, style.textOpacity);
        context.strokeText(line.text, centerX, baseline);
      }
      context.fillText(line.text, centerX, baseline);
      context.restore();
      lineTop += lineBoxHeight;
    }
    if (groupIndex < groups.length - 1) lineTop += groupGap;
  }
  return canvasToPng(canvas);
}

export async function renderSubtitleDataUrl(cue: SubtitleCue, style: SubtitleStyle) {
  const blob = await renderSubtitlePng(cue, style);
  return URL.createObjectURL(blob);
}

export function trackedSubtitleStyle(
  item: TrackedSubtitleCue,
  projectStyle: SubtitleStyle,
) {
  const style = normalizeSubtitleStyle({ ...projectStyle, ...item.cue.subtitleStyle });
  if (item.track === 1 && item.cue.subtitleStyle?.positionY === undefined) {
    style.positionY = Math.min(80, style.positionY + 16);
  }
  return style;
}

export async function renderSubtitleGroupPng(
  cues: TrackedSubtitleCue[],
  projectStyle: SubtitleStyle,
  reusableCanvas?: HTMLCanvasElement,
  reusableLayerCanvas?: HTMLCanvasElement,
) {
  const canvas = reusableCanvas ?? document.createElement("canvas");
  canvas.width = SUBTITLE_CANVAS_WIDTH;
  canvas.height = SUBTITLE_CANVAS_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法初始化双轨字幕画布");
  const layerCanvas = reusableLayerCanvas ?? document.createElement("canvas");

  for (const item of cues.toSorted((left, right) => left.track - right.track)) {
    if (!item.cue.sourceText.trim() && !item.cue.targetText.trim()) continue;
    const layer = await renderSubtitlePng(item.cue, trackedSubtitleStyle(item, projectStyle), layerCanvas);
    const bitmap = await createImageBitmap(layer);
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
  }
  return canvasToPng(canvas);
}

export async function renderSubtitleGroupDataUrl(cues: TrackedSubtitleCue[], projectStyle: SubtitleStyle) {
  return URL.createObjectURL(await renderSubtitleGroupPng(cues, projectStyle));
}

export async function renderBurnOverlays(
  cues: SubtitleCue[],
  projectStyle: SubtitleStyle,
  onProgress: (percent: number) => void,
) {
  const renderTimeline = buildSubtitleRenderSegments(cues);
  const overlays: BurnOverlay[] = [];
  // Keep preview and export rendering identical while avoiding a new 1080p
  // canvas allocation for every cue in long videos.
  const reusableCanvas = document.createElement("canvas");
  const reusableLayerCanvas = document.createElement("canvas");
  for (const [index, segment] of renderTimeline.entries()) {
    const png = await renderSubtitleGroupPng(segment.cues, projectStyle, reusableCanvas, reusableLayerCanvas);
    overlays.push({ startMs: segment.startMs, endMs: segment.endMs, png });
    onProgress(((index + 1) / Math.max(1, renderTimeline.length)) * 10);
    if (index % 2 === 1) await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  }
  const blankCanvas = document.createElement("canvas");
  blankCanvas.width = SUBTITLE_CANVAS_WIDTH;
  blankCanvas.height = SUBTITLE_CANVAS_HEIGHT;
  const blankPng = await canvasToPng(blankCanvas);
  return { overlayBundleBase64: await packBurnOverlays(overlays, blankPng) };
}
