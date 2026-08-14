export type CueStatus = "draft" | "reviewed" | "approved";

export type SubtitleCue = {
  id: string;
  position: number;
  startMs: number;
  endMs: number;
  speaker: string;
  sourceText: string;
  targetText: string;
  status: CueStatus;
  subtitleStyle?: Partial<SubtitleStyle>;
};

export type SubtitleStyle = {
  positionX: number;
  positionY: number;
  sourceColor: string;
  targetColor: string;
  sourceFontSize: number;
  targetFontSize: number;
  sourceFontFamily: string;
  targetFontFamily: string;
  bold: boolean;
  shadow: boolean;
  outlineColor: string;
  outlineWidth: number;
  textOpacity: number;
  backgroundEnabled: boolean;
  backgroundColor: string;
  backgroundOpacity: number;
  lineHeight: number;
  lineGap: number;
};

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  positionX: 50,
  positionY: 5,
  sourceColor: "#f7f8f4",
  targetColor: "#ffe37b",
  sourceFontSize: 48,
  targetFontSize: 52,
  sourceFontFamily: "Arial",
  targetFontFamily: "Microsoft YaHei",
  bold: true,
  shadow: true,
  outlineColor: "#000000",
  outlineWidth: 0,
  textOpacity: 1,
  backgroundEnabled: true,
  backgroundColor: "#666666",
  backgroundOpacity: 0.62,
  lineHeight: 1.18,
  lineGap: 6,
};

function styleNumber(value: unknown, fallback: number, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function styleString(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

export function normalizeSubtitleStyle(value?: Partial<SubtitleStyle> | null): SubtitleStyle {
  const input = value ?? {};
  return {
    positionX: styleNumber(input.positionX, 50, 3, 97),
    positionY: styleNumber(input.positionY, 5, 1, 80),
    sourceColor: styleString(input.sourceColor, DEFAULT_SUBTITLE_STYLE.sourceColor),
    targetColor: styleString(input.targetColor, DEFAULT_SUBTITLE_STYLE.targetColor),
    sourceFontSize: styleNumber(input.sourceFontSize, 48, 18, 96),
    targetFontSize: styleNumber(input.targetFontSize, 52, 18, 96),
    sourceFontFamily: styleString(input.sourceFontFamily, DEFAULT_SUBTITLE_STYLE.sourceFontFamily),
    targetFontFamily: styleString(input.targetFontFamily, DEFAULT_SUBTITLE_STYLE.targetFontFamily),
    bold: typeof input.bold === "boolean" ? input.bold : true,
    shadow: typeof input.shadow === "boolean" ? input.shadow : true,
    outlineColor: styleString(input.outlineColor, DEFAULT_SUBTITLE_STYLE.outlineColor),
    outlineWidth: styleNumber(input.outlineWidth, 0, 0, 8),
    textOpacity: styleNumber(input.textOpacity, 1, 0.1, 1),
    backgroundEnabled: typeof input.backgroundEnabled === "boolean" ? input.backgroundEnabled : true,
    backgroundColor: styleString(input.backgroundColor, DEFAULT_SUBTITLE_STYLE.backgroundColor),
    backgroundOpacity: styleNumber(input.backgroundOpacity, 0.62, 0, 1),
    lineHeight: styleNumber(input.lineHeight, 1.18, 0.9, 1.8),
    lineGap: styleNumber(input.lineGap, 6, 0, 36),
  };
}

export function normalizeSubtitleStyleOverride(value?: Partial<SubtitleStyle> | null): Partial<SubtitleStyle> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const normalized = normalizeSubtitleStyle(value);
  const override: Partial<SubtitleStyle> = {};
  for (const key of Object.keys(DEFAULT_SUBTITLE_STYLE) as (keyof SubtitleStyle)[]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      (override as Record<keyof SubtitleStyle, SubtitleStyle[keyof SubtitleStyle]>)[key] = normalized[key];
    }
  }
  return Object.keys(override).length ? override : undefined;
}

export type StudioProject = {
  id: string;
  name: string;
  videoPath: string;
  videoUrl?: string;
  durationMs: number;
  createdAt: string;
  updatedAt: string;
  burnedAt?: string;
  subtitleStyle: SubtitleStyle;
  sourceContext?: VideoSourceContext;
  cues: SubtitleCue[];
};

export type VideoSourceContext = {
  title: string;
  description: string;
  channel: string;
  verifiedTerms: string[];
};

export type ProjectSummary = Pick<
  StudioProject,
  "id" | "name" | "videoPath" | "durationMs" | "createdAt" | "updatedAt" | "burnedAt"
> & { cueCount: number };

export type YoutubeDownloadState = {
  active: boolean;
  percent: number;
  status: string;
  detail: string;
};

export type DownloadedSubtitleTrack = {
  language: string;
  content: string;
};
