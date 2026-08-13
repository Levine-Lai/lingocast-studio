import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { SubtitleCue } from "../types";
import { clamp, formatClock } from "../lib/time";

type Props = {
  cues: SubtitleCue[];
  durationMs: number;
  currentMs: number;
  playing: boolean;
  selectedCueId: string | null;
  onSeek: (milliseconds: number) => void;
  onSelect: (cueId: string) => void;
  onUpdate: (cueId: string, patch: Partial<SubtitleCue>, options?: { historyGroup?: string }) => void;
};

type DragMode = "move" | "resize-start" | "resize-end";

type DragState = {
  cueId: string;
  mode: DragMode;
  pointerX: number;
  startMs: number;
  endMs: number;
  millisecondsPerPixel: number;
  historyGroup: string;
};

type ScrubState = {
  pointerId: number;
  canvasLeft: number;
  active: boolean;
  timer: number;
};

const MIN_CUE_DURATION_MS = 200;
const MIN_PIXELS_PER_SECOND = 20;
const MAX_PIXELS_PER_SECOND = 500;
const SNAP_THRESHOLD_MS = 160;

function tickStep(pixelsPerSecond: number) {
  if (pixelsPerSecond >= 180) return 1_000;
  if (pixelsPerSecond >= 90) return 5_000;
  if (pixelsPerSecond >= 45) return 10_000;
  return 30_000;
}

export function Timeline({ cues, durationMs, currentMs, playing, selectedCueId, onSeek, onSelect, onUpdate }: Props) {
  const [pixelsPerSecond, setPixelsPerSecond] = useState(70);
  const dragRef = useRef<DragState | null>(null);
  const scrubRef = useRef<ScrubState | null>(null);
  const snapTargetsRef = useRef<Array<{ cueId: string | null; time: number }>>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(pixelsPerSecond);
  const end = Math.max(durationMs, cues.at(-1)?.endMs ?? 0, 10_000);
  const canvasWidth = Math.max(900, (end / 1000) * pixelsPerSecond);
  const playheadLeft = (currentMs / 1000) * pixelsPerSecond;
  const step = tickStep(pixelsPerSecond);
  const ticks = useMemo(
    () => Array.from({ length: Math.ceil(end / step) + 1 }, (_, index) => index * step),
    [end, step],
  );
  snapTargetsRef.current = [
    { cueId: null, time: 0 },
    { cueId: null, time: currentMs },
    { cueId: null, time: end },
    ...cues.flatMap((cue) => [
      { cueId: cue.id, time: cue.startMs },
      { cueId: cue.id, time: cue.endMs },
    ]),
  ];

  function snapTime(requested: number, cueId: string) {
    let closest = requested;
    let distance = SNAP_THRESHOLD_MS + 1;
    for (const target of snapTargetsRef.current) {
      if (target.cueId === cueId) continue;
      const nextDistance = Math.abs(target.time - requested);
      if (nextDistance <= SNAP_THRESHOLD_MS && nextDistance < distance) {
        distance = nextDistance;
        closest = target.time;
      }
    }
    return closest;
  }

  useEffect(() => {
    zoomRef.current = pixelsPerSecond;
  }, [pixelsPerSecond]);

  const zoomAt = useCallback((requested: number, clientX?: number) => {
    const scroller = scrollRef.current;
    const previous = zoomRef.current;
    const next = clamp(requested, MIN_PIXELS_PER_SECOND, MAX_PIXELS_PER_SECOND);
    if (!scroller || Math.abs(next - previous) < 0.01) return;
    const bounds = scroller.getBoundingClientRect();
    const localX = typeof clientX === "number" ? clientX - bounds.left : bounds.width / 2;
    const secondsAtPointer = (scroller.scrollLeft + localX) / previous;
    zoomRef.current = next;
    setPixelsPerSecond(next);
    requestAnimationFrame(() => {
      scroller.scrollLeft = Math.max(0, secondsAtPointer * next - localX);
    });
  }, []);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let pinch: { distance: number; pixelsPerSecond: number; secondsAtCenter: number } | null = null;
    let pinchFrame = 0;
    let pendingPinch: { pixelsPerSecond: number; scrollLeft: number } | null = null;
    const distance = (touches: TouchList) => Math.hypot(
      touches[0].clientX - touches[1].clientX,
      touches[0].clientY - touches[1].clientY,
    );
    const centerX = (touches: TouchList) => (touches[0].clientX + touches[1].clientX) / 2;

    function onWheel(event: WheelEvent) {
      if (!event.deltaY) return;
      event.preventDefault();
      zoomAt(zoomRef.current * (event.deltaY < 0 ? 1.14 : 0.88), event.clientX);
    }

    function onTouchStart(event: TouchEvent) {
      if (event.touches.length !== 2) return;
      event.preventDefault();
      const bounds = scroller!.getBoundingClientRect();
      const localX = centerX(event.touches) - bounds.left;
      pinch = {
        distance: Math.max(1, distance(event.touches)),
        pixelsPerSecond: zoomRef.current,
        secondsAtCenter: (scroller!.scrollLeft + localX) / zoomRef.current,
      };
    }

    function onTouchMove(event: TouchEvent) {
      if (event.touches.length !== 2 || !pinch) return;
      event.preventDefault();
      const bounds = scroller!.getBoundingClientRect();
      const localX = centerX(event.touches) - bounds.left;
      const next = clamp(
        pinch.pixelsPerSecond * (distance(event.touches) / pinch.distance),
        MIN_PIXELS_PER_SECOND,
        MAX_PIXELS_PER_SECOND,
      );
      pendingPinch = {
        pixelsPerSecond: next,
        scrollLeft: Math.max(0, pinch.secondsAtCenter * next - localX),
      };
      if (pinchFrame) return;
      pinchFrame = window.requestAnimationFrame(() => {
        pinchFrame = 0;
        if (!pendingPinch) return;
        zoomRef.current = pendingPinch.pixelsPerSecond;
        setPixelsPerSecond(pendingPinch.pixelsPerSecond);
        scroller!.scrollLeft = pendingPinch.scrollLeft;
        pendingPinch = null;
      });
    }

    function onTouchEnd(event: TouchEvent) {
      if (event.touches.length < 2) pinch = null;
    }

    scroller.addEventListener("wheel", onWheel, { passive: false });
    scroller.addEventListener("touchstart", onTouchStart, { passive: false });
    scroller.addEventListener("touchmove", onTouchMove, { passive: false });
    scroller.addEventListener("touchend", onTouchEnd, { passive: true });
    scroller.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("touchstart", onTouchStart);
      scroller.removeEventListener("touchmove", onTouchMove);
      scroller.removeEventListener("touchend", onTouchEnd);
      scroller.removeEventListener("touchcancel", onTouchEnd);
      window.cancelAnimationFrame(pinchFrame);
    };
  }, [zoomAt]);

  useEffect(() => {
    if (!playing) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    const padding = Math.min(160, scroller.clientWidth * 0.18);
    if (playheadLeft < scroller.scrollLeft + padding || playheadLeft > scroller.scrollLeft + scroller.clientWidth - padding) {
      scroller.scrollLeft = Math.max(0, playheadLeft - scroller.clientWidth * 0.35);
    }
  }, [playheadLeft, playing]);

  useEffect(() => {
    function move(event: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const delta = Math.round((event.clientX - drag.pointerX) * drag.millisecondsPerPixel);
      if (drag.mode === "move") {
        const duration = drag.endMs - drag.startMs;
        const requestedStart = Math.max(0, drag.startMs + delta);
        const snappedStart = snapTime(requestedStart, drag.cueId);
        const snappedEnd = snapTime(requestedStart + duration, drag.cueId) - duration;
        const startMs = Math.max(0, Math.abs(snappedStart - requestedStart) <= Math.abs(snappedEnd - requestedStart)
          ? snappedStart
          : snappedEnd);
        onUpdate(drag.cueId, { startMs, endMs: startMs + duration }, { historyGroup: drag.historyGroup });
      } else if (drag.mode === "resize-start") {
        const startMs = snapTime(drag.startMs + delta, drag.cueId);
        onUpdate(
          drag.cueId,
          { startMs: clamp(startMs, 0, drag.endMs - MIN_CUE_DURATION_MS) },
          { historyGroup: drag.historyGroup },
        );
      } else {
        const endMs = snapTime(drag.endMs + delta, drag.cueId);
        onUpdate(
          drag.cueId,
          { endMs: Math.max(drag.startMs + MIN_CUE_DURATION_MS, endMs) },
          { historyGroup: drag.historyGroup },
        );
      }
    }

    function stop() {
      dragRef.current = null;
      document.body.classList.remove("timeline-dragging");
    }

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.classList.remove("timeline-dragging");
      if (scrubRef.current) window.clearTimeout(scrubRef.current.timer);
      scrubRef.current = null;
      document.body.classList.remove("playhead-scrubbing");
    };
  }, [onUpdate]);

  function startDrag(event: ReactPointerEvent, cue: SubtitleCue, mode: DragMode) {
    event.preventDefault();
    event.stopPropagation();
    if (document.activeElement instanceof HTMLElement && document.activeElement !== event.currentTarget) {
      document.activeElement.blur();
    }
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus({ preventScroll: true });
    onSelect(cue.id);
    if (mode === "move") onSeek(cue.startMs);
    dragRef.current = {
      cueId: cue.id,
      mode,
      pointerX: event.clientX,
      startMs: cue.startMs,
      endMs: cue.endMs,
      millisecondsPerPixel: 1000 / pixelsPerSecond,
      historyGroup: `timeline-drag-${cue.id}-${event.pointerId}-${Date.now()}`,
    };
    document.body.classList.add("timeline-dragging");
  }

  function moveCueWithKeyboard(event: KeyboardEvent, cue: SubtitleCue) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = (event.shiftKey ? 1_000 : 100) * (event.key === "ArrowLeft" ? -1 : 1);
    const duration = cue.endMs - cue.startMs;
    const startMs = Math.max(0, cue.startMs + delta);
    onUpdate(cue.id, { startMs, endMs: startMs + duration });
  }

  function resizeWithKeyboard(event: KeyboardEvent, cue: SubtitleCue, edge: "start" | "end") {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    const delta = (event.shiftKey ? 1_000 : 100) * (event.key === "ArrowLeft" ? -1 : 1);
    if (edge === "start") {
      onUpdate(cue.id, { startMs: clamp(cue.startMs + delta, 0, cue.endMs - MIN_CUE_DURATION_MS) });
    } else {
      onUpdate(cue.id, { endMs: Math.max(cue.startMs + MIN_CUE_DURATION_MS, cue.endMs + delta) });
    }
  }

  function seekAt(clientX: number, canvasLeft: number) {
    onSeek(clamp(((clientX - canvasLeft) / pixelsPerSecond) * 1000, 0, end));
  }

  function beginScrub(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    seekAt(event.clientX, bounds.left);
    const state: ScrubState = {
      pointerId: event.pointerId,
      canvasLeft: bounds.left,
      active: false,
      timer: 0,
    };
    state.timer = window.setTimeout(() => {
      state.active = true;
      document.body.classList.add("playhead-scrubbing");
    }, 180);
    scrubRef.current = state;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is optional on older WebView builds.
    }
  }

  function moveScrub(event: ReactPointerEvent<HTMLDivElement>) {
    const scrub = scrubRef.current;
    if (!scrub || scrub.pointerId !== event.pointerId || !scrub.active) return;
    event.preventDefault();
    seekAt(event.clientX, scrub.canvasLeft);
  }

  function endScrub(event: ReactPointerEvent<HTMLDivElement>) {
    const scrub = scrubRef.current;
    if (!scrub || scrub.pointerId !== event.pointerId) return;
    window.clearTimeout(scrub.timer);
    scrubRef.current = null;
    document.body.classList.remove("playhead-scrubbing");
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer may already have been released by the WebView.
    }
  }

  const cueClips = useMemo(() => cues.map((cue) => {
    const left = (cue.startMs / 1000) * pixelsPerSecond;
    const width = Math.max(18, ((cue.endMs - cue.startMs) / 1000) * pixelsPerSecond);
    return (
      <div
        key={cue.id}
        className={cue.id === selectedCueId ? "cue-clip active" : "cue-clip"}
        style={{ left: `${left}px`, width: `${width}px` }}
        role="button"
        tabIndex={0}
        aria-label={`${formatClock(cue.startMs, true)} 到 ${formatClock(cue.endMs, true)}，${cue.sourceText || "空字幕"}`}
        title="拖动片段移动时间；拖动两侧手柄调整字幕长度"
        onPointerDown={(event) => startDrag(event, cue, "move")}
        onKeyDown={(event) => moveCueWithKeyboard(event, cue)}
      >
        <span
          className="clip-handle start"
          role="separator"
          tabIndex={0}
          aria-label="调整字幕开始时间"
          onPointerDown={(event) => startDrag(event, cue, "resize-start")}
          onKeyDown={(event) => resizeWithKeyboard(event, cue, "start")}
        />
        <span className="clip-copy"><b>{cue.sourceText || "空字幕"}</b>{cue.targetText ? <small>{cue.targetText}</small> : null}</span>
        <span
          className="clip-handle end"
          role="separator"
          tabIndex={0}
          aria-label="调整字幕结束时间"
          onPointerDown={(event) => startDrag(event, cue, "resize-end")}
          onKeyDown={(event) => resizeWithKeyboard(event, cue, "end")}
        />
      </div>
    );
  }), [cues, onSeek, onSelect, onUpdate, pixelsPerSecond, selectedCueId]);

  return (
    <section className="timeline-panel" aria-label="字幕时间轴">
        <div className="timeline-zoom timeline-floating">
          <span title="鼠标滚轮或触摸屏双指缩放">滚轮 / 双指缩放</span>
          <button type="button" onClick={() => zoomAt(zoomRef.current - 20)} aria-label="缩小时间轴">−</button>
          <input
            type="range"
            min={MIN_PIXELS_PER_SECOND}
            max={MAX_PIXELS_PER_SECOND}
            step="4"
            value={pixelsPerSecond}
            onChange={(event) => zoomAt(Number(event.target.value))}
            aria-label="时间轴缩放"
          />
          <button type="button" onClick={() => zoomAt(zoomRef.current + 20)} aria-label="放大时间轴">＋</button>
          <time>{formatClock(currentMs, true)} / {formatClock(end, true)}</time>
        </div>

      <div className="timeline-scroll" ref={scrollRef}>
        <div
          className="timeline-canvas"
          style={{ width: `${canvasWidth}px` }}
          title="点击定位；长按后拖动播放头"
          onPointerDown={beginScrub}
          onPointerMove={moveScrub}
          onPointerUp={endScrub}
          onPointerCancel={endScrub}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="time-ruler" aria-hidden="true">
            {ticks.map((milliseconds) => (
              <span key={milliseconds} style={{ left: `${(milliseconds / 1000) * pixelsPerSecond}px` }}>
                <i />{formatClock(milliseconds)}
              </span>
            ))}
          </div>
          <div className="waveform-lane" aria-hidden="true" />
          <div className="subtitle-lane">
            <span className="lane-label">字幕</span>
            {cueClips}
          </div>
          <div className="playhead" style={{ transform: `translate3d(${playheadLeft}px, 0, 0)` }} aria-hidden="true"><span /></div>
        </div>
      </div>
    </section>
  );
}
