import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { CueList } from "./components/CueList";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { Timeline } from "./components/Timeline";
import { VideoPreview } from "./components/VideoPreview";
import { YoutubeImportDialog } from "./components/YoutubeImportDialog";
import { useStudio } from "./hooks/useStudio";
import { burnSubtitleVideo, downloadYoutubeVideo, exportSubtitleFile, isTauri, pickSubtitleFile, pickVideoFile, reviewYoutubeSubtitleContext, translateSubtitleCues } from "./lib/platform";
import { applySubtitleCorrections, buildBilingualCues, parseSrt, resegmentCues, splitSubtitleText } from "./lib/srt";
import type { SubtitleCue, SubtitleStyle, YoutubeDownloadState } from "./types";

const IDLE_DOWNLOAD: YoutubeDownloadState = {
  active: false,
  percent: 0,
  status: "",
  detail: "",
};
const SIDEBAR_STORAGE_KEY = "lingocast.ui.sidebar-collapsed.v1";
const LAYOUT_STORAGE_KEY = "lingocast.ui.editor-layout.v2";

type LayoutPreferences = {
  timelineHeight: number;
  cueListHeight: number;
  cueRowHeight: number;
};

const DEFAULT_LAYOUT: LayoutPreferences = {
  timelineHeight: 170,
  cueListHeight: 250,
  cueRowHeight: 96,
};

function readLayoutPreferences() {
  try {
    return { ...DEFAULT_LAYOUT, ...JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) || "{}") } as LayoutPreferences;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function clampLayout(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function removeStylePatch(override: Partial<SubtitleStyle> | undefined, patch: Partial<SubtitleStyle>) {
  if (!override) return undefined;
  const next = { ...override };
  for (const key of Object.keys(patch) as (keyof SubtitleStyle)[]) delete next[key];
  return Object.keys(next).length ? next : undefined;
}

function fileStem(name: string) {
  return name.replace(/\.[^.]+$/, "") || "未命名视频";
}

export default function App() {
  const studio = useStudio();
  const videoInputRef = useRef<HTMLInputElement>(null);
  const subtitleInputRef = useRef<HTMLInputElement>(null);
  const cueClipboardRef = useRef<SubtitleCue | null>(null);
  const automaticTranslationAttempts = useRef(new Set<string>());
  const shortcutHandlerRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  const [currentMs, setCurrentMs] = useState(0);
  const [notice, setNotice] = useState("");
  const [youtubeDialogOpen, setYoutubeDialogOpen] = useState(false);
  const [youtubeDownload, setYoutubeDownload] = useState<YoutubeDownloadState>(IDLE_DOWNLOAD);
  const [youtubeError, setYoutubeError] = useState("");
  const [subtitleProcessing, setSubtitleProcessing] = useState(false);
  const [videoExporting, setVideoExporting] = useState(false);
  const [videoExportProgress, setVideoExportProgress] = useState(0);
  const [playbackToggleSignal, setPlaybackToggleSignal] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [layout, setLayout] = useState(readLayoutPreferences);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 5_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!studio.error) return;
    const timer = window.setTimeout(() => studio.setError(""), 5_000);
    return () => window.clearTimeout(timer);
  }, [studio.error, studio.setError]);

  shortcutHandlerRef.current = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      const target = event.target;
      const editingText = target instanceof HTMLElement
        && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
      if (modifier) {
        if (key === "s") {
          event.preventDefault();
          void studio.save();
          return;
        }
        if (editingText) return;
        if (key === "z") {
          event.preventDefault();
          if (event.shiftKey) studio.redo();
          else studio.undo();
          return;
        }
        if (key === "y") {
          event.preventDefault();
          studio.redo();
          return;
        }
        if (key === "c" && studio.selectedCue) {
          event.preventDefault();
          copySelectedCue();
          return;
        }
        if (key === "x" && studio.selectedCue) {
          event.preventDefault();
          copySelectedCue();
          deleteCue();
          return;
        }
        if (key === "v" && studio.project) {
          event.preventDefault();
          void pasteCue();
          return;
        }
        if (key === "a" && studio.selectedCueId) {
          event.preventDefault();
          const source = document.querySelector<HTMLTextAreaElement>(`[data-cue-id="${studio.selectedCueId}"] textarea`);
          source?.focus();
          source?.select();
          return;
        }
      }
      if (!editingText && event.key === "Delete" && studio.selectedCue) {
        event.preventDefault();
        deleteCue();
        return;
      }
      if ((event.code !== "Space" && event.key !== " ") || event.ctrlKey || event.metaKey || event.altKey || youtubeDialogOpen) return;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, button, [contenteditable='true']")) return;
      event.preventDefault();
      setPlaybackToggleSignal((value) => value + 1);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => shortcutHandlerRef.current(event);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // Resizing remains available even if local storage is unavailable.
    }
  }, [layout]);

  useEffect(() => {
    setCurrentMs(0);
    setPlaying(false);
  }, [studio.project?.id]);

  useEffect(() => {
    if (!playing || !studio.project) return;
    const active = studio.project.cues.find((cue) => cue.startMs <= currentMs && cue.endMs >= currentMs);
    if (active && active.id !== studio.selectedCueId) studio.setSelectedCueId(active.id);
  }, [currentMs, playing, studio.project, studio.selectedCueId, studio.setSelectedCueId]);

  useEffect(() => {
    const project = studio.project;
    if (!isTauri() || !project || subtitleProcessing || automaticTranslationAttempts.current.has(project.id)) return;
    const hasSource = project.cues.some((cue) => cue.sourceText.trim());
    const hasTranslation = project.cues.some((cue) => cue.targetText.trim());
    if (!hasSource || hasTranslation) return;
    automaticTranslationAttempts.current.add(project.id);
    setSubtitleProcessing(true);
    setNotice(`正在自动为「${project.name}」补全中文字幕…`);
    const organized = resegmentCues(project.cues);
    void translateSubtitleCues(organized, project.sourceContext)
      .then(async (translated) => {
        await studio.replaceCuesAndSave(translated);
        setNotice(`已自动保存 ${translated.length} 条中英双语字幕`);
      })
      .catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : String(reason);
        studio.setError(`自动生成中文字幕失败，可点击“整理并翻译”重试：${message}`);
      })
      .finally(() => setSubtitleProcessing(false));
  }, [studio.project, studio.replaceCuesAndSave, studio.setError, subtitleProcessing]);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((collapsed) => {
      const next = !collapsed;
      try {
        localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // The layout still works when storage is unavailable.
      }
      return next;
    });
  }, []);

  function beginPanelResize(event: ReactPointerEvent<HTMLDivElement>, panel: "timeline" | "cues") {
    event.preventDefault();
    const startY = event.clientY;
    const startValue = panel === "timeline" ? layout.timelineHeight : layout.cueListHeight;
    let frame = 0;
    const move = (pointer: PointerEvent) => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const requested = startValue - (pointer.clientY - startY);
        setLayout((current) => panel === "timeline"
          ? { ...current, timelineHeight: clampLayout(requested, 96, window.innerHeight * 0.52) }
          : { ...current, cueListHeight: clampLayout(requested, 130, window.innerHeight * 0.58) });
      });
    };
    const stop = () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.classList.remove("panel-resizing");
    };
    document.body.classList.add("panel-resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }

  function copySelectedCue() {
    const cue = studio.selectedCue;
    if (!cue) return;
    cueClipboardRef.current = { ...cue };
    void navigator.clipboard?.writeText([cue.sourceText, cue.targetText].filter(Boolean).join("\n")).catch(() => undefined);
    setNotice("已复制当前字幕，可用 Ctrl+V 粘贴为新字幕");
  }

  async function pasteCue() {
    if (!studio.project) return;
    let copied = cueClipboardRef.current;
    if (!copied) {
      const text = await navigator.clipboard?.readText().catch(() => "");
      if (!text?.trim()) return;
      const [sourceText, ...targetLines] = text.trim().split(/\r?\n/);
      copied = {
        id: "",
        position: 0,
        startMs: currentMs,
        endMs: currentMs + 2500,
        speaker: "",
        sourceText,
        targetText: targetLines.join(" ").trim(),
        status: "draft",
      };
    }
    const duration = Math.max(300, copied.endMs - copied.startMs);
    const cue = {
      ...copied,
      id: crypto.randomUUID(),
      startMs: Math.round(currentMs),
      endMs: Math.round(currentMs + duration),
      status: "draft" as const,
    };
    const selectedIndex = studio.project.cues.findIndex((item) => item.id === studio.selectedCueId);
    const insertAt = selectedIndex >= 0 ? selectedIndex + 1 : studio.project.cues.length;
    const cues = [...studio.project.cues];
    cues.splice(insertAt, 0, cue);
    studio.replaceCues(cues);
    studio.setSelectedCueId(cue.id);
    setNotice("已在播放头位置粘贴字幕");
  }

  async function importVideo() {
    studio.setError("");
    if (!isTauri()) {
      videoInputRef.current?.click();
      return;
    }
    const selected = await pickVideoFile();
    if (selected) {
      await studio.addProject({
        name: selected.name,
        videoPath: selected.path,
        videoUrl: selected.url,
      });
    }
  }

  async function importSubtitle() {
    if (!studio.project) return;
    studio.setError("");
    if (!isTauri()) {
      subtitleInputRef.current?.click();
      return;
    }
    const selected = await pickSubtitleFile();
    if (!selected) return;
    await studio.replaceCuesAndSave(selected.cues);
    setNotice(`已导入 ${selected.cues.length} 条字幕`);
  }

  function openYoutubeDialog() {
    setYoutubeError("");
    setYoutubeDownload(IDLE_DOWNLOAD);
    setYoutubeDialogOpen(true);
  }

  const closeYoutubeDialog = useCallback(() => {
    setYoutubeDialogOpen(false);
  }, []);

  async function importYoutube(url: string, cookiePath: string, browserProfile: string) {
    setYoutubeError("");
    setYoutubeDownload({ active: true, percent: 0, status: "正在解析视频", detail: "连接 YouTube" });
    try {
      const downloaded = await downloadYoutubeVideo(url, cookiePath, browserProfile, (progress) => {
        setYoutubeDownload({ active: true, ...progress });
      });
      let generatedCues = buildBilingualCues(downloaded.subtitles);
      let sourceContext = downloaded.sourceContext;
      let preparedCues: SubtitleCue[] = generatedCues;
      let translationError = "";
      let reviewWarning = "";
      if (generatedCues.length) {
        setYoutubeDownload({
          active: true,
          percent: 96,
          status: "正在审查专名和术语",
          detail: "结合标题、简介和完整转录统一规范拼写",
        });
        try {
          const reviewed = await reviewYoutubeSubtitleContext(generatedCues, sourceContext);
          sourceContext = reviewed.sourceContext;
          generatedCues = applySubtitleCorrections(generatedCues, reviewed.corrections);
          preparedCues = generatedCues;
        } catch (reason) {
          reviewWarning = reason instanceof Error ? reason.message : String(reason);
        }
        setYoutubeDownload({
          active: true,
          percent: 97,
          status: "DeepSeek 正在翻译",
          detail: `正在处理 ${generatedCues.length} 条完整语句`,
        });
        try {
          preparedCues = await translateSubtitleCues(generatedCues, sourceContext);
        } catch (reason) {
          translationError = reason instanceof Error ? reason.message : String(reason);
        }
      }
      const bilingualCount = preparedCues.filter((cue) => cue.targetText).length;
      const project = await studio.addProject({
        name: downloaded.name,
        videoPath: downloaded.path,
        videoUrl: downloaded.url,
        sourceContext,
      }, preparedCues);
      if (!project) throw new Error("视频已下载，但创建本地项目失败");
      setYoutubeDownload({ active: false, percent: 100, status: "下载完成", detail: "" });
      setYoutubeDialogOpen(false);
      if (translationError) studio.setError(`英文字幕和断句已生成，但 DeepSeek 翻译失败：${translationError}`);
      else if (reviewWarning) studio.setError(`字幕已生成，但导入前专名预审未完成，翻译阶段仍已按上下文校正：${reviewWarning}`);
      setNotice(bilingualCount
        ? `已自动整理并生成 ${preparedCues.length} 条中英字幕`
        : preparedCues.length
          ? `已整理为 ${preparedCues.length} 条英文字幕，中文字幕生成失败`
          : `已添加「${downloaded.name}」，但该视频没有可用的英文字幕`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setYoutubeError(message);
      setYoutubeDownload(IDLE_DOWNLOAD);
    }
  }

  async function organizeAndTranslate() {
    if (!studio.project?.cues.length || subtitleProcessing) return;
    studio.setError("");
    setSubtitleProcessing(true);
    const organized = resegmentCues(studio.project.cues);
    setNotice(`正在按口语字幕规则重新翻译当前项目的 ${organized.length} 条字幕…`);
    try {
      const translated = await translateSubtitleCues(organized, studio.project.sourceContext);
      await studio.replaceCuesAndSave(translated);
      setNotice(`已按新的口语规则重新翻译并保存 ${translated.length} 条字幕`);
    } catch (reason) {
      await studio.replaceCuesAndSave(organized);
      const message = reason instanceof Error ? reason.message : String(reason);
      studio.setError(`断句已整理为 ${organized.length} 条，但 DeepSeek 翻译失败：${message}`);
    } finally {
      setSubtitleProcessing(false);
    }
  }

  function addCue() {
    if (!studio.project) return;
    const cue: SubtitleCue = {
      id: crypto.randomUUID(),
      position: studio.project.cues.length,
      startMs: Math.round(currentMs),
      endMs: Math.round(currentMs + 2500),
      speaker: "",
      sourceText: "",
      targetText: "",
      status: "draft",
    };
    studio.replaceCues([...studio.project.cues, cue]);
    studio.setSelectedCueId(cue.id);
  }

  function splitCue() {
    const project = studio.project;
    const cue = studio.selectedCue;
    if (!project || !cue) return;
    const splitAt = currentMs > cue.startMs + 100 && currentMs < cue.endMs - 100
      ? Math.round(currentMs)
      : Math.round((cue.startMs + cue.endMs) / 2);
    const ratio = (splitAt - cue.startMs) / Math.max(1, cue.endMs - cue.startMs);
    const [sourceBefore, sourceAfter] = splitSubtitleText(cue.sourceText, ratio);
    const [targetBefore, targetAfter] = splitSubtitleText(cue.targetText, ratio);
    const nextCue: SubtitleCue = {
      ...cue,
      id: crypto.randomUUID(),
      startMs: splitAt,
      sourceText: sourceAfter,
      targetText: targetAfter,
      status: "draft",
    };
    const cues = project.cues.flatMap((item) => item.id === cue.id
      ? [{ ...item, endMs: splitAt, sourceText: sourceBefore, targetText: targetBefore, status: "draft" as const }, nextCue]
      : [item]);
    studio.replaceCues(cues);
    studio.setSelectedCueId(nextCue.id);
  }

  function mergeCue() {
    const project = studio.project;
    const cue = studio.selectedCue;
    if (!project || !cue) return;
    const index = project.cues.findIndex((item) => item.id === cue.id);
    const next = project.cues[index + 1];
    if (!next) return;
    studio.replaceCues(project.cues
      .filter((item) => item.id !== next.id)
      .map((item) => item.id === cue.id ? {
        ...item,
        endMs: next.endMs,
        sourceText: `${item.sourceText} ${next.sourceText}`.trim(),
        targetText: `${item.targetText} ${next.targetText}`.trim(),
        status: "draft" as const,
      } : item));
    studio.setSelectedCueId(cue.id);
  }

  function deleteCue() {
    if (!studio.project || !studio.selectedCueId) return;
    const remaining = studio.project.cues.filter((cue) => cue.id !== studio.selectedCueId);
    studio.replaceCues(remaining);
    studio.setSelectedCueId(null);
  }

  function shiftCue(delta: number) {
    const cue = studio.selectedCue;
    if (!cue) return;
    const applied = Math.max(-cue.startMs, delta);
    studio.updateCue(cue.id, { startMs: cue.startMs + applied, endMs: cue.endMs + applied });
  }

  async function exportSrt() {
    if (!studio.project) return;
    const completed = await exportSubtitleFile(studio.project.name, studio.project.cues);
    if (completed) setNotice("双语 SRT 已导出");
  }

  async function exportBurnedVideo() {
    if (!studio.project?.cues.length || videoExporting) return;
    studio.setError("");
    setVideoExporting(true);
    setVideoExportProgress(0);
    try {
      await studio.save();
      const output = await burnSubtitleVideo(studio.project, (percent) => setVideoExportProgress(percent));
      if (!output) {
        setNotice("");
      } else {
        await studio.markBurned();
        if (output.coverPath) {
          setNotice(`烧录视频和 YouTube 封面已导出：${output.videoPath}；${output.coverPath}`);
        } else {
          setNotice(`烧录视频已导出：${output.videoPath}`);
          if (output.coverError) studio.setError(`视频导出成功，但 YouTube 封面导出失败：${output.coverError}`);
        }
      }
    } catch (reason) {
      studio.setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setVideoExporting(false);
    }
  }

  return (
    <main className={sidebarCollapsed ? "studio-shell sidebar-collapsed" : "studio-shell"}>
      <input
        ref={videoInputRef}
        className="visually-hidden"
        type="file"
        accept="video/*"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          void studio.addProject({ name: fileStem(file.name), videoPath: file.name, videoUrl: URL.createObjectURL(file) });
          event.target.value = "";
        }}
      />
      <input
        ref={subtitleInputRef}
        className="visually-hidden"
        type="file"
        accept=".srt,text/plain"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          void file.text().then(async (text) => {
            const cues = parseSrt(text);
            await studio.replaceCuesAndSave(cues);
            setNotice(`已导入 ${cues.length} 条字幕`);
          });
          event.target.value = "";
        }}
      />

      <ProjectSidebar
        projects={studio.projects}
        selectedId={studio.project?.id}
        onChoose={(id) => void studio.chooseProject(id)}
        onDelete={(id, name) => void studio.removeProject(id).then((removed) => {
          if (removed) setNotice(`已删除项目「${name}」，原视频文件已保留`);
        })}
        onImportVideo={() => void importVideo()}
        onImportYoutube={openYoutubeDialog}
        collapsed={sidebarCollapsed}
        onToggle={toggleSidebar}
      />

      <section className="studio-main">
        <header className="studio-toolbar">
          <div className="project-title">
            <span className={studio.dirty ? "save-dot dirty" : "save-dot"} aria-hidden="true" />
            <div><strong>{studio.project?.name ?? "LingoCast Studio"}</strong><small>{studio.dirty ? "有未保存修改" : "本地项目已保存"}</small></div>
          </div>
          <div className="toolbar-actions">
            <button type="button" onClick={openYoutubeDialog}>YouTube 网址</button>
            <button type="button" onClick={() => void importSubtitle()} disabled={!studio.project}>导入 SRT</button>
            <button type="button" onClick={() => void organizeAndTranslate()} disabled={!studio.project?.cues.length || subtitleProcessing}>
              {subtitleProcessing ? "DeepSeek 处理中…" : "整理并翻译"}
            </button>
            <button type="button" onClick={addCue} disabled={!studio.project}>新增字幕</button>
            <button className="primary" type="button" onClick={() => void studio.save()} disabled={!studio.project || studio.saving || !studio.dirty}>
              {studio.saving ? "保存中…" : "保存 Ctrl+S"}
            </button>
            <button type="button" onClick={() => void exportSrt()} disabled={!studio.project?.cues.length}>导出字幕</button>
            <button className="export" type="button" onClick={() => void exportBurnedVideo()} disabled={!studio.project?.cues.length || videoExporting}>
              {videoExporting ? "正在烧录…" : "烧录导出视频"}
            </button>
          </div>
        </header>

        {videoExporting ? (
          <div
            className="video-export-progress"
            role="progressbar"
            aria-label="视频烧录进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(videoExportProgress)}
          >
            <div><span>正在烧录中英字幕视频</span><strong>{videoExportProgress.toFixed(1)}%</strong></div>
            <progress max="100" value={videoExportProgress} />
            <small>编码期间请保持软件打开，完成后会显示保存位置</small>
          </div>
        ) : null}

        {studio.error ? <div className="message-banner error" role="alert"><span>!</span>{studio.error}<button type="button" onClick={() => studio.setError("")}>×</button></div> : null}
        {notice ? <div className="message-banner success" role="status"><span>✓</span>{notice}<button type="button" onClick={() => setNotice("")}>×</button></div> : null}

        {studio.loading ? (
          <div className="loading-state"><span /><p>正在打开本地项目…</p></div>
        ) : studio.project ? (
          <div
            className="editor-layout"
            style={{
              "--timeline-height": `${layout.timelineHeight}px`,
              "--cue-list-height": `${layout.cueListHeight}px`,
              "--cue-row-height": `${layout.cueRowHeight}px`,
            } as CSSProperties}
          >
            <div className="editor-left">
              <VideoPreview
                source={studio.project.videoUrl}
                projectName={studio.project.name}
                cues={studio.project.cues}
                currentMs={currentMs}
                playbackToggleSignal={playbackToggleSignal}
                subtitleStyle={studio.project.subtitleStyle}
                onTimeChange={setCurrentMs}
                onDurationChange={(durationMs) => studio.updateProject((project) => ({ ...project, durationMs }))}
                onPlaybackChange={setPlaying}
                onStyleChange={(patch, applyToAll, cueId) => studio.updateProject((project) => applyToAll ? ({
                  ...project,
                  subtitleStyle: { ...project.subtitleStyle, ...patch },
                  cues: project.cues.map((cue) => ({ ...cue, subtitleStyle: removeStylePatch(cue.subtitleStyle, patch) })),
                }) : ({
                  ...project,
                  cues: project.cues.map((cue) => cue.id === cueId
                    ? { ...cue, subtitleStyle: { ...cue.subtitleStyle, ...patch } }
                    : cue),
                }))}
                onCueTextChange={(cueId, field, value) => studio.updateCue(cueId, { [field]: value })}
              />
              <div
                className="panel-resize-handle"
                role="separator"
                aria-label="调整画面预览和字幕时间轴高度"
                aria-orientation="horizontal"
                title="拖动调整画面预览和字幕时间轴高度"
                onPointerDown={(event) => beginPanelResize(event, "timeline")}
              ><span /></div>
              <Timeline
                cues={studio.project.cues}
                durationMs={studio.project.durationMs}
                currentMs={currentMs}
                playing={playing}
                selectedCueId={studio.selectedCueId}
                onSeek={setCurrentMs}
                onSelect={studio.setSelectedCueId}
                onUpdate={studio.updateCue}
              />
              <div className="edit-tools" role="toolbar" aria-label="字幕条目工具">
                <button type="button" onClick={addCue} title="在播放头位置创建字幕">＋新增字幕块</button>
                <button type="button" onClick={studio.undo} disabled={!studio.canUndo} title="Ctrl+Z">撤销</button>
                <button type="button" onClick={studio.redo} disabled={!studio.canRedo} title="Ctrl+Y / Ctrl+Shift+Z">重做</button>
                <button type="button" onClick={() => shiftCue(-100)} disabled={!studio.selectedCue}>−100ms</button>
                <button type="button" onClick={() => shiftCue(100)} disabled={!studio.selectedCue}>+100ms</button>
                <button type="button" onClick={splitCue} disabled={!studio.selectedCue}>在播放头拆分</button>
                <button type="button" onClick={mergeCue} disabled={!studio.selectedCue}>与下一条合并</button>
                <label className="row-height-control" title="调整字幕编辑行高">
                  <span>行高</span>
                  <input
                    type="range"
                    min="72"
                    max="170"
                    step="2"
                    value={layout.cueRowHeight}
                    onChange={(event) => setLayout((current) => ({ ...current, cueRowHeight: Number(event.target.value) }))}
                    aria-label="字幕编辑行高"
                  />
                </label>
                <button className="danger" type="button" onClick={deleteCue} disabled={!studio.selectedCue} title="Delete">删除</button>
              </div>
            </div>
            <div
              className="panel-resize-handle outer"
              role="separator"
              aria-label="调整字幕编辑区域高度"
              aria-orientation="horizontal"
              title="拖动调整字幕编辑区域高度"
              onPointerDown={(event) => beginPanelResize(event, "cues")}
            ><span /></div>
            <CueList
              cues={studio.project.cues}
              selectedCueId={studio.selectedCueId}
              onSelect={studio.setSelectedCueId}
              onSeek={setCurrentMs}
              onUpdate={studio.updateCue}
            />
          </div>
        ) : (
          <div className="welcome-state">
            <div className="welcome-visual"><span>CC</span><i /><i /><i /></div>
            <p className="eyebrow">LOCAL-FIRST SUBTITLE WORKSPACE</p>
            <h1>把视频变成<br />可审核的双语字幕。</h1>
            <p>导入本地视频或粘贴 YouTube 网址，随后添加 SRT 字幕，即可开始对轴、编辑、检查与导出。</p>
            <div className="welcome-actions">
              <button type="button" onClick={openYoutubeDialog}>粘贴 YouTube 网址 <span>▶</span></button>
              <button type="button" onClick={() => void importVideo()}>选择本地视频 <span>→</span></button>
            </div>
            <small>视频与字幕不会离开你的电脑</small>
          </div>
        )}
      </section>

      {youtubeDialogOpen ? (
        <YoutubeImportDialog
          download={youtubeDownload}
          error={youtubeError}
          onClose={closeYoutubeDialog}
          onSubmit={importYoutube}
        />
      ) : null}
    </main>
  );
}
