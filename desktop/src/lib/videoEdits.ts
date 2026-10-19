import type { SubtitleCue, VideoSegment } from "../types";

export const IMPLICIT_VIDEO_SEGMENT_ID = "full-video";
const MIN_VIDEO_SEGMENT_MS = 100;

export function normalizeVideoSegments(segments: VideoSegment[] | undefined, durationMs: number): VideoSegment[] {
  const safeDuration = Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0;
  if (!segments?.length) {
    return safeDuration > 0
      ? [{ id: IMPLICIT_VIDEO_SEGMENT_ID, startMs: 0, endMs: safeDuration, removed: false }]
      : [];
  }
  return segments
    .map((segment) => ({
      ...segment,
      startMs: Math.max(0, Math.round(segment.startMs)),
      endMs: safeDuration > 0
        ? Math.min(safeDuration, Math.max(0, Math.round(segment.endMs)))
        : Math.max(0, Math.round(segment.endMs)),
      removed: Boolean(segment.removed),
    }))
    .filter((segment) => segment.endMs > segment.startMs)
    .toSorted((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
}

export function splitVideoSegment(
  segments: VideoSegment[] | undefined,
  durationMs: number,
  splitMs: number,
  makeId: () => string = () => crypto.randomUUID(),
) {
  const normalized = normalizeVideoSegments(segments, durationMs);
  const at = Math.round(splitMs);
  const index = normalized.findIndex((segment) =>
    at >= segment.startMs + MIN_VIDEO_SEGMENT_MS && at <= segment.endMs - MIN_VIDEO_SEGMENT_MS,
  );
  if (index < 0) return { segments: normalized, selectedId: null };
  const current = normalized[index];
  const left = { ...current, id: makeId(), endMs: at };
  const right = { ...current, id: makeId(), startMs: at };
  return {
    segments: [...normalized.slice(0, index), left, right, ...normalized.slice(index + 1)],
    selectedId: right.id,
  };
}

export function setVideoSegmentRemoved(segments: VideoSegment[], segmentId: string, removed: boolean) {
  return segments.map((segment) => segment.id === segmentId ? { ...segment, removed } : segment);
}

export function keptVideoSegments(segments: VideoSegment[] | undefined, durationMs: number) {
  return normalizeVideoSegments(segments, durationMs).filter((segment) => !segment.removed);
}

export function hasVideoCuts(segments: VideoSegment[] | undefined) {
  return Boolean(segments?.some((segment) => segment.removed));
}

export function editedVideoDurationMs(segments: VideoSegment[] | undefined, durationMs: number) {
  return keptVideoSegments(segments, durationMs)
    .reduce((total, segment) => total + segment.endMs - segment.startMs, 0);
}

export function nextPlayableSourceMs(segments: VideoSegment[] | undefined, durationMs: number, sourceMs: number) {
  const kept = keptVideoSegments(segments, durationMs);
  const current = kept.find((segment) => segment.startMs <= sourceMs && sourceMs < segment.endMs);
  if (current) return sourceMs;
  return kept.find((segment) => segment.startMs >= sourceMs)?.startMs ?? null;
}

export function remapCuesToEditedVideo(
  cues: SubtitleCue[],
  segments: VideoSegment[] | undefined,
  durationMs: number,
) {
  const kept = keptVideoSegments(segments, durationMs);
  let outputOffset = 0;
  const remapped: SubtitleCue[] = [];
  for (const segment of kept) {
    for (const cue of cues) {
      const visibleStart = Math.max(cue.startMs, segment.startMs);
      const visibleEnd = Math.min(cue.endMs, segment.endMs);
      if (visibleEnd <= visibleStart) continue;
      remapped.push({
        ...cue,
        id: remapped.some((item) => item.id === cue.id) ? `${cue.id}-cut-${segment.id}` : cue.id,
        startMs: outputOffset + visibleStart - segment.startMs,
        endMs: outputOffset + visibleEnd - segment.startMs,
      });
    }
    outputOffset += segment.endMs - segment.startMs;
  }
  return remapped
    .toSorted((left, right) => left.startMs - right.startMs || left.position - right.position)
    .map((cue, position) => ({ ...cue, position }));
}
