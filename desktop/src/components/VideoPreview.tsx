import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { SubtitleStylePanel } from "./SubtitleStylePanel";
import { normalizeSubtitleStyle, type SubtitleCue, type SubtitleStyle } from "../types";
import { clamp, formatClock } from "../lib/time";
import { buildSubtitleRenderTimeline, renderSubtitleDataUrl } from "../lib/subtitleRaster";
import { normalizeSubtitleEditorText } from "../lib/srt";

type Props = {
  source?: string;
  projectName: string;
  cues: SubtitleCue[];
  currentMs: number;
  playbackToggleSignal: number;
  subtitleStyle: SubtitleStyle;
  onTimeChange: (milliseconds: number) => void;
  onDurationChange: (milliseconds: number) => void;
  onPlaybackChange: (playing: boolean) => void;
  onStyleChange: (patch: Partial<SubtitleStyle>, applyToAll: boolean, cueId?: string) => void;
  onCueTextChange: (cueId: string, field: "sourceText" | "targetText", value: string) => void;
};

type SubtitleDrag = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  moved: boolean;
};

const MAX_SUBTITLE_RASTER_CACHE = 32;

function subtitleRasterCacheKey(cue: SubtitleCue, style: SubtitleStyle) {
  return JSON.stringify([cue.id, cue.sourceText, cue.targetText, style]);
}

async function decodeRaster(url: string) {
  const image = new Image();
  image.src = url;
  await image.decode().catch(() => undefined);
}

function hexToRgba(hex: string, opacity: number) {
  const normalized = hex.replace("#", "");
  const value = normalized.length === 3
    ? normalized.split("").map((part) => part + part).join("")
    : normalized.padEnd(6, "0").slice(0, 6);
  const number = Number.parseInt(value, 16);
  return `rgba(${(number >> 16) & 255}, ${(number >> 8) & 255}, ${number & 255}, ${opacity})`;
}

export function VideoPreview({
  source,
  projectName,
  cues,
  currentMs,
  playbackToggleSignal,
  subtitleStyle,
  onTimeChange,
  onDurationChange,
  onPlaybackChange,
  onStyleChange,
  onCueTextChange,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<SubtitleDrag | null>(null);
  const lastPlaybackSignal = useRef(playbackToggleSignal);
  const sourceTextRef = useRef<HTMLSpanElement>(null);
  const targetTextRef = useRef<HTMLSpanElement>(null);
  const singleClickTimer = useRef<number | null>(null);
  const rasterCacheRef = useRef(new Map<string, string>());
  const rasterPendingRef = useRef(new Map<string, Promise<string>>());
  const activeRasterKeyRef = useRef("");
  const rasterGenerationRef = useRef(0);
  const [videoDurationMs, setVideoDurationMs] = useState(0);
  const [videoAspectRatio, setVideoAspectRatio] = useState(16 / 9);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [styleEditorOpen, setStyleEditorOpen] = useState(false);
  const [editingField, setEditingField] = useState<"sourceText" | "targetText" | null>(null);
  const [applyToAll, setApplyToAll] = useState(false);
  const [, bumpRasterRevision] = useState(0);
  const renderTimeline = useMemo(() => buildSubtitleRenderTimeline(cues), [cues]);
  const activeCue = renderTimeline.find((cue) => cue.startMs <= currentMs && currentMs < cue.endMs);
  const effectiveStyle = useMemo(
    () => normalizeSubtitleStyle({ ...subtitleStyle, ...activeCue?.subtitleStyle }),
    [activeCue?.subtitleStyle, subtitleStyle],
  );
  const [previewStyle, setPreviewStyle] = useState(effectiveStyle);
  const timelineEnd = Math.max(1, videoDurationMs, ...cues.map((cue) => cue.endMs));
  const subtitleRasterKey = activeCue
    ? subtitleRasterCacheKey(activeCue, previewStyle)
    : "";
  activeRasterKeyRef.current = subtitleRasterKey;
  const subtitleRasterUrl = rasterCacheRef.current.get(subtitleRasterKey) ?? "";

  useLayoutEffect(() => {
    setPreviewStyle(applyToAll ? normalizeSubtitleStyle(subtitleStyle) : effectiveStyle);
  }, [applyToAll, effectiveStyle, subtitleStyle]);
  useLayoutEffect(() => setEditingField(null), [activeCue?.id]);

  const ensureSubtitleRaster = useCallback((cue: SubtitleCue, style: SubtitleStyle) => {
    const key = subtitleRasterCacheKey(cue, style);
    const cached = rasterCacheRef.current.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = rasterPendingRef.current.get(key);
    if (pending) return pending;
    const generation = rasterGenerationRef.current;
    const task = renderSubtitleDataUrl(cue, style)
      .then(async (url) => {
        await decodeRaster(url);
        if (generation !== rasterGenerationRef.current) {
          URL.revokeObjectURL(url);
          return "";
        }
        const cache = rasterCacheRef.current;
        cache.set(key, url);
        while (cache.size > MAX_SUBTITLE_RASTER_CACHE) {
          const oldestKey = cache.keys().next().value as string | undefined;
          if (!oldestKey) break;
          if (oldestKey === activeRasterKeyRef.current) {
            const activeUrl = cache.get(oldestKey);
            cache.delete(oldestKey);
            if (activeUrl) cache.set(oldestKey, activeUrl);
            continue;
          }
          const oldestUrl = cache.get(oldestKey);
          cache.delete(oldestKey);
          if (oldestUrl) URL.revokeObjectURL(oldestUrl);
        }
        if (activeRasterKeyRef.current === key) bumpRasterRevision((revision) => revision + 1);
        return url;
      })
      .finally(() => rasterPendingRef.current.delete(key));
    rasterPendingRef.current.set(key, task);
    return task;
  }, []);

  useEffect(() => {
    rasterGenerationRef.current += 1;
    return () => {
      rasterGenerationRef.current += 1;
      for (const url of rasterCacheRef.current.values()) URL.revokeObjectURL(url);
      rasterCacheRef.current.clear();
      rasterPendingRef.current.clear();
    };
  }, [source]);

  useEffect(() => {
    if (!activeCue || (!activeCue.sourceText.trim() && !activeCue.targetText.trim())) return;
    void ensureSubtitleRaster(activeCue, previewStyle);
  }, [activeCue, ensureSubtitleRaster, previewStyle]);

  useEffect(() => {
    if (!activeCue) return;
    const activeIndex = renderTimeline.findIndex((cue) => cue.id === activeCue.id);
    if (activeIndex < 0) return;
    const nearbyCues = renderTimeline.slice(
      Math.max(0, activeIndex - 2),
      Math.min(renderTimeline.length, activeIndex + 5),
    );
    for (const cue of nearbyCues) {
      if (!cue.sourceText.trim() && !cue.targetText.trim()) continue;
      const style = cue.id === activeCue.id
        ? previewStyle
        : normalizeSubtitleStyle({ ...subtitleStyle, ...cue.subtitleStyle });
      void ensureSubtitleRaster(cue, style);
    }
  }, [activeCue, ensureSubtitleRaster, previewStyle, renderTimeline, subtitleStyle]);

  useEffect(() => () => {
    if (singleClickTimer.current !== null) window.clearTimeout(singleClickTimer.current);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || Math.abs(video.currentTime * 1000 - currentMs) < 350) return;
    video.currentTime = currentMs / 1000;
  }, [currentMs]);

  const togglePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  }, []);

  useEffect(() => {
    if (lastPlaybackSignal.current === playbackToggleSignal) return;
    lastPlaybackSignal.current = playbackToggleSignal;
    togglePlayback();
  }, [playbackToggleSignal, togglePlayback]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let lastUpdate = 0;
    const update = (timestamp: number) => {
      const video = videoRef.current;
      if (!video || video.paused) return;
      if (timestamp - lastUpdate >= 28) {
        lastUpdate = timestamp;
        onTimeChange(video.currentTime * 1000);
      }
      frame = window.requestAnimationFrame(update);
    };
    frame = window.requestAnimationFrame(update);
    return () => window.cancelAnimationFrame(frame);
  }, [onTimeChange, playing]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateFrameSize = () => {
      const bounds = stage.getBoundingClientRect();
      const width = Math.min(bounds.width, bounds.height * videoAspectRatio);
      const height = width / videoAspectRatio;
      const next = { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
      setFrameSize((current) => current?.width === next.width && current.height === next.height ? current : next);
    };
    updateFrameSize();
    const observer = new ResizeObserver(updateFrameSize);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [videoAspectRatio]);

  function beginSubtitleDrag(event: ReactPointerEvent<HTMLDivElement>) {
    event.stopPropagation();
    if (editingField) return;
    if (document.activeElement instanceof HTMLElement && document.activeElement !== event.currentTarget) {
      document.activeElement.blur();
    }
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: previewStyle.positionX,
      startY: previewStyle.positionY,
      currentX: previewStyle.positionX,
      currentY: previewStyle.positionY,
      moved: false,
    };
  }

  function moveSubtitle(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const frame = frameRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !frame) return;
    const bounds = frame.getBoundingClientRect();
    const deltaX = event.clientX - drag.startClientX;
    const deltaY = event.clientY - drag.startClientY;
    if (Math.abs(deltaX) + Math.abs(deltaY) > 4) drag.moved = true;
    if (!drag.moved) return;
    drag.currentX = clamp(drag.startX + (deltaX / bounds.width) * 100, 3, 97);
    drag.currentY = clamp(drag.startY - (deltaY / bounds.height) * 100, 1, 80);
    setPreviewStyle((current) => ({
      ...current,
      positionX: drag.currentX,
      positionY: drag.currentY,
    }));
  }

  function finishSubtitleDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (drag.moved) {
      onStyleChange({ positionX: drag.currentX, positionY: drag.currentY }, applyToAll, activeCue?.id);
    } else {
      if (singleClickTimer.current !== null) window.clearTimeout(singleClickTimer.current);
      singleClickTimer.current = window.setTimeout(() => {
        setStyleEditorOpen(true);
        singleClickTimer.current = null;
      }, 230);
    }
  }

  function beginTextEditing(event: ReactMouseEvent<HTMLSpanElement>, field: "sourceText" | "targetText") {
    event.preventDefault();
    event.stopPropagation();
    if (singleClickTimer.current !== null) {
      window.clearTimeout(singleClickTimer.current);
      singleClickTimer.current = null;
    }
    setStyleEditorOpen(true);
    setEditingField(field);
    const clientX = event.clientX;
    const clientY = event.clientY;
    window.requestAnimationFrame(() => {
      const element = field === "sourceText" ? sourceTextRef.current : targetTextRef.current;
      if (!element) return;
      element.focus();
      const selection = window.getSelection();
      const range = document.caretRangeFromPoint?.(clientX, clientY);
      if (!selection || !range || !element.contains(range.startContainer)) return;
      selection.removeAllRanges();
      selection.addRange(range);
      const wordSelection = selection as Selection & { modify?: (alter: string, direction: string, granularity: string) => void };
      wordSelection.modify?.("move", "backward", "word");
      wordSelection.modify?.("extend", "forward", "word");
    });
  }

  function finishTextEditing(field: "sourceText" | "targetText", element: HTMLSpanElement) {
    if (activeCue) onCueTextChange(activeCue.id, field, normalizeSubtitleEditorText(element.innerText));
    setEditingField(null);
  }

  const textShadow = previewStyle.shadow
    ? "0 1px 2px #000, 0 2px 5px rgba(0,0,0,.88)"
    : "none";
  const lineStyle = {
    lineHeight: previewStyle.lineHeight,
    opacity: previewStyle.textOpacity,
    textShadow,
    WebkitTextStroke: `calc(${previewStyle.outlineWidth * 0.0521}cqw) ${previewStyle.outlineColor}`,
  };
  const backgroundStyle = previewStyle.backgroundEnabled
    ? { backgroundColor: hexToRgba(previewStyle.backgroundColor, previewStyle.backgroundOpacity) }
    : { backgroundColor: "transparent", boxShadow: "none" };
  const hasSourceText = Boolean(activeCue?.sourceText.trim());
  const hasTargetText = Boolean(activeCue?.targetText.trim());

  return (
    <section className="preview-panel" aria-label="视频预览">
      <div className="panel-title">
        <span>画面预览</span>
        <div>
          <small>{projectName}</small>
          <span className="fit-badge">烧录预览</span>
          <button type="button" onClick={() => setStyleEditorOpen((open) => !open)}>字幕样式</button>
          <button type="button" onClick={() => void frameRef.current?.requestFullscreen()} disabled={!source}>全屏</button>
        </div>
      </div>
      <div className={styleEditorOpen ? "preview-workspace style-open" : "preview-workspace"}>
        <div className="video-stage" ref={stageRef}>
          {source ? (
          <div
            className="video-frame"
            ref={frameRef}
            style={frameSize ? { width: `${frameSize.width}px`, height: `${frameSize.height}px` } : undefined}
          >
            <video
              ref={videoRef}
              src={source}
              tabIndex={0}
              aria-label="视频画面"
              onTimeUpdate={(event) => onTimeChange(event.currentTarget.currentTime * 1000)}
              onLoadedMetadata={(event) => {
                const duration = event.currentTarget.duration * 1000;
                const { videoWidth, videoHeight } = event.currentTarget;
                if (videoWidth > 0 && videoHeight > 0) setVideoAspectRatio(videoWidth / videoHeight);
                setVideoDurationMs(duration);
                onDurationChange(duration);
              }}
              onPlay={() => { setPlaying(true); onPlaybackChange(true); }}
              onPause={() => { setPlaying(false); onPlaybackChange(false); }}
              onEnded={() => onPlaybackChange(false)}
              onClick={togglePlayback}
            />
            {subtitleRasterUrl && !editingField ? (
              <img className="subtitle-raster" src={subtitleRasterUrl} alt="" aria-hidden="true" />
            ) : null}
            {activeCue && (hasSourceText || hasTargetText) ? (
              <div
                className={`subtitle-preview${styleEditorOpen ? " selected" : ""}${editingField ? " editing" : ""}${subtitleRasterUrl && !editingField ? " rasterized" : ""}`}
                style={{
                  left: `${previewStyle.positionX}%`,
                  bottom: `${previewStyle.positionY}%`,
                  gap: `${previewStyle.lineGap * 0.0521}cqw`,
                }}
                role="button"
                tabIndex={0}
                aria-label="拖动字幕位置，点击编辑字幕样式"
                title="拖动调整位置 · 点击编辑样式"
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setStyleEditorOpen(true); }}
                onPointerDown={beginSubtitleDrag}
                onPointerMove={moveSubtitle}
                onPointerUp={finishSubtitleDrag}
                onPointerCancel={() => { dragRef.current = null; setPreviewStyle(applyToAll ? normalizeSubtitleStyle(subtitleStyle) : effectiveStyle); }}
              >
                {hasSourceText ? (
                  <p
                    className="subtitle-source"
                    style={{ ...lineStyle, color: previewStyle.sourceColor, fontFamily: previewStyle.sourceFontFamily, fontSize: `${previewStyle.sourceFontSize * 0.0521}cqw`, fontWeight: previewStyle.bold ? 700 : 400 }}
                  ><span
                    ref={sourceTextRef}
                    style={backgroundStyle}
                    contentEditable={editingField === "sourceText"}
                    suppressContentEditableWarning
                    data-subtitle-field="sourceText"
                    onDoubleClick={(event) => beginTextEditing(event, "sourceText")}
                    onBlur={(event) => finishTextEditing("sourceText", event.currentTarget)}
                  >{activeCue.sourceText}</span></p>
                ) : null}
                {hasTargetText ? (
                  <strong
                    className="subtitle-target"
                    style={{ ...lineStyle, color: previewStyle.targetColor, fontFamily: previewStyle.targetFontFamily, fontSize: `${previewStyle.targetFontSize * 0.0521}cqw`, fontWeight: previewStyle.bold ? 700 : 400 }}
                  ><span
                    ref={targetTextRef}
                    style={backgroundStyle}
                    contentEditable={editingField === "targetText"}
                    suppressContentEditableWarning
                    data-subtitle-field="targetText"
                    onDoubleClick={(event) => beginTextEditing(event, "targetText")}
                    onBlur={(event) => finishTextEditing("targetText", event.currentTarget)}
                  >{activeCue.targetText}</span></strong>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="video-missing"><span>▶</span><p>重新选择视频以恢复预览</p></div>
        )}
        </div>
        {styleEditorOpen ? (
          <SubtitleStylePanel
            style={previewStyle}
            onChange={(patch) => {
              setPreviewStyle((current) => normalizeSubtitleStyle({ ...current, ...patch }));
              onStyleChange(patch, applyToAll || !activeCue, activeCue?.id);
            }}
            applyToAll={applyToAll || !activeCue}
            canEditSingle={Boolean(activeCue)}
            onApplyToAllChange={(checked) => setApplyToAll(checked)}
            onClose={() => { setStyleEditorOpen(false); setEditingField(null); }}
          />
        ) : null}
      </div>
      <div className="transport-controls">
        <button type="button" onClick={() => onTimeChange(Math.max(0, currentMs - 5000))} aria-label="后退五秒">−5s</button>
        <button className="play-button" type="button" onClick={togglePlayback} aria-label="播放或暂停" title="空格键播放或暂停">{playing ? "Ⅱ" : "▶"}</button>
        <button type="button" onClick={() => onTimeChange(currentMs + 5000)} aria-label="前进五秒">+5s</button>
        <time>{formatClock(currentMs, true)}</time>
        <input aria-label="播放进度" type="range" min={0} max={timelineEnd} step={10} value={clamp(currentMs, 0, timelineEnd)} onChange={(event) => onTimeChange(Number(event.target.value))} />
      </div>
    </section>
  );
}
