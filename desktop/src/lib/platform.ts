import type { DownloadedSubtitleTrack, StudioProject, SubtitleCue, VideoSourceContext } from "../types";
import { normalizeSubtitleEditorText, parseSrt, renderSrt, sanitizeSubtitleText } from "./srt";
import { renderBurnOverlays } from "./subtitleRaster";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export const isTauri = () => typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

function safeExportFilename(name: string) {
  return name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").trim().slice(0, 96) || "LingoCast";
}

function exportPath(directory: string, filename: string) {
  return `${directory.replace(/[\\/]$/, "")}\\${filename}`;
}

type YoutubeProgressEvent = {
  jobId: string;
  percent: number;
  status: string;
  detail: string;
};

type DownloadedYoutubeVideo = {
  path: string;
  name: string;
  subtitles: DownloadedSubtitleTrack[];
  sourceContext: VideoSourceContext;
};

export type BurnedVideoOutput = {
  videoPath: string;
  coverPath: string | null;
  coverError: string | null;
};

export async function downloadYoutubeVideo(
  url: string,
  cookiePath: string,
  browserProfile: string,
  onProgress: (progress: Omit<YoutubeProgressEvent, "jobId">) => void,
): Promise<{ path: string; url: string; name: string; subtitles: DownloadedSubtitleTrack[]; sourceContext: VideoSourceContext }> {
  if (!isTauri()) throw new Error("YouTube 下载只能在桌面软件中运行");
  const [{ invoke, convertFileSrc }, { listen }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/event"),
  ]);
  const jobId = crypto.randomUUID();
  const unlisten = await listen<YoutubeProgressEvent>("youtube-download-progress", (event) => {
    if (event.payload.jobId !== jobId) return;
    onProgress({
      percent: event.payload.percent,
      status: event.payload.status,
      detail: event.payload.detail,
    });
  });
  try {
    const downloaded = await invoke<DownloadedYoutubeVideo>("download_youtube", {
      url,
      jobId,
      cookiePath: cookiePath.trim() || null,
      browserProfile: cookiePath.trim() ? null : browserProfile.trim() || null,
    });
    return { ...downloaded, url: convertFileSrc(downloaded.path) };
  } finally {
    unlisten();
  }
}

export async function openYoutubeLogin(browser: string) {
  if (!isTauri()) throw new Error("YouTube 登录只能在桌面软件中使用");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_youtube_login", { browser });
}

export async function pickYoutubeCookieFile() {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  return open({
    multiple: false,
    directory: false,
    filters: [{ name: "Netscape cookies.txt", extensions: ["txt"] }],
  });
}

export async function translateSubtitleCues(cues: SubtitleCue[], sourceContext?: VideoSourceContext) {
  if (!isTauri()) throw new Error("DeepSeek 翻译只能在桌面软件中运行");
  const { invoke } = await import("@tauri-apps/api/core");
  const translated = await invoke<Array<{ id: string; sourceText: string; targetText: string; speaker: string }>>("translate_subtitles", {
    cues: cues.map((cue) => ({ id: cue.id, sourceText: cue.sourceText })),
    sourceContext: sourceContext ?? null,
  });
  const byId = new Map(translated.map((cue) => [cue.id, cue]));
  return cues.map((cue) => {
    const result = byId.get(cue.id);
    return result ? {
      ...cue,
      sourceText: sanitizeSubtitleText(result.sourceText || cue.sourceText),
      targetText: sanitizeSubtitleText(result.targetText),
      speaker: cue.speaker || result.speaker,
      status: "draft" as const,
    } : cue;
  });
}

export async function reviewYoutubeSubtitleContext(cues: SubtitleCue[], sourceContext: VideoSourceContext) {
  if (!isTauri()) return { sourceContext, corrections: [] };
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<{ sourceContext: VideoSourceContext; corrections: Array<{ wrong: string; correct: string }> }>(
    "review_youtube_subtitle_context",
    {
      cues: cues.map((cue) => ({ id: cue.id, sourceText: cue.sourceText })),
      sourceContext,
    },
  );
}

export async function pickVideoFile(): Promise<{ path: string; url: string; name: string } | null> {
  if (!isTauri()) return null;
  const [{ open }, { convertFileSrc }] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/api/core"),
  ]);
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "视频", extensions: ["mp4", "mov", "mkv", "webm", "m4v"] }],
  });
  if (!path) return null;
  const name = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "未命名视频";
  return { path, url: convertFileSrc(path), name };
}

export async function pickSubtitleFile(): Promise<{ path: string; cues: SubtitleCue[] } | null> {
  if (!isTauri()) return null;
  const [{ open }, { readTextFile }] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/plugin-fs"),
  ]);
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "SubRip 字幕", extensions: ["srt"] }],
  });
  if (!path) return null;
  return { path, cues: parseSrt(await readTextFile(path)) };
}

export async function exportSubtitleFile(name: string, cues: SubtitleCue[]) {
  const content = renderSrt(cues);
  if (isTauri()) {
    const [{ save }, { writeTextFile }, { invoke }] = await Promise.all([
      import("@tauri-apps/plugin-dialog"),
      import("@tauri-apps/plugin-fs"),
      import("@tauri-apps/api/core"),
    ]);
    const directory = await invoke<string>("ensure_export_directory", { projectName: name });
    const path = await save({
      defaultPath: exportPath(directory, `${safeExportFilename(name)}.bilingual.srt`),
      filters: [{ name: "SubRip 字幕", extensions: ["srt"] }],
    });
    if (!path) return false;
    await writeTextFile(path, content);
    return true;
  }

  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${name}.bilingual.srt`;
  anchor.click();
  URL.revokeObjectURL(url);
  return true;
}

export async function burnSubtitleVideo(
  project: StudioProject,
  onProgress: (percent: number) => void,
) {
  if (!isTauri()) throw new Error("视频烧录只能在桌面软件中运行");
  const [{ save }, { invoke }, { listen }] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/event"),
  ]);
  const directory = await invoke<string>("ensure_export_directory", { projectName: project.name });
  const outputPath = await save({
    defaultPath: exportPath(directory, `${safeExportFilename(project.name)}.burned.mp4`),
    filters: [{ name: "MP4 视频", extensions: ["mp4"] }],
  });
  if (!outputPath) return null;
  const { overlays, blankPngBase64 } = await renderBurnOverlays(project.cues, project.subtitleStyle, onProgress);
  const jobId = crypto.randomUUID();
  const unlisten = await listen<{ jobId: string; percent: number }>("video-burn-progress", (event) => {
    if (event.payload.jobId === jobId) onProgress(10 + event.payload.percent * 0.9);
  });
  try {
    return await invoke<BurnedVideoOutput>("burn_video", {
      videoPath: project.videoPath,
      outputPath,
      style: project.subtitleStyle,
      durationMs: Math.max(project.durationMs, project.cues.at(-1)?.endMs ?? 0),
      jobId,
      overlays,
      blankPngBase64,
      cues: project.cues.map((cue) => ({
        startMs: cue.startMs,
        endMs: cue.endMs,
        sourceText: normalizeSubtitleEditorText(cue.sourceText),
        targetText: normalizeSubtitleEditorText(cue.targetText),
        style: { ...project.subtitleStyle, ...cue.subtitleStyle },
      })),
    });
  } finally {
    unlisten();
  }
}
