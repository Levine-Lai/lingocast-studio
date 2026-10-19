import type { SubtitleCue } from "../types";

export type SubtitleTrack = 0 | 1;

export type TrackedSubtitleCue = {
  cue: SubtitleCue;
  track: SubtitleTrack;
};

export type SubtitleRenderSegment = {
  startMs: number;
  endMs: number;
  cues: TrackedSubtitleCue[];
};

function orderedCues(cues: SubtitleCue[]) {
  return cues
    .map((cue, sourceIndex) => ({ cue, sourceIndex }))
    .toSorted((left, right) =>
      left.cue.startMs - right.cue.startMs
      || left.cue.position - right.cue.position
      || left.sourceIndex - right.sourceIndex,
    );
}

/** Assigns overlapping cues to a second visual track without changing stored cue data. */
export function assignSubtitleTracks(cues: SubtitleCue[]): TrackedSubtitleCue[] {
  const trackEnds: [number, number] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  return orderedCues(cues).map(({ cue }) => {
    const startMs = Math.max(0, cue.startMs);
    let track: SubtitleTrack;
    if (cue.kind === "note") track = 1;
    else if (startMs >= trackEnds[0]) track = 0;
    else if (startMs >= trackEnds[1]) track = 1;
    else track = trackEnds[0] <= trackEnds[1] ? 0 : 1;
    trackEnds[track] = Math.max(trackEnds[track], cue.endMs);
    return { cue, track };
  });
}

function segmentKey(cues: TrackedSubtitleCue[]) {
  return cues.map(({ cue, track }) => `${track}:${cue.id}`).join("|");
}

/** Produces non-overlapping render intervals, each containing up to one cue per track. */
export function buildSubtitleRenderSegments(cues: SubtitleCue[]): SubtitleRenderSegment[] {
  const tracked = assignSubtitleTracks(cues);
  const boundaries = Array.from(new Set(tracked.flatMap(({ cue }) => [
    Math.max(0, cue.startMs),
    Math.max(Math.max(0, cue.startMs), cue.endMs),
  ]))).toSorted((left, right) => left - right);
  const segments: SubtitleRenderSegment[] = [];

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startMs = boundaries[index];
    const endMs = boundaries[index + 1];
    if (endMs <= startMs) continue;
    const active = tracked
      .filter(({ cue }) => cue.startMs < endMs && cue.endMs > startMs)
      .toSorted((left, right) => left.track - right.track || left.cue.position - right.cue.position)
      .filter((item, itemIndex, items) => items.findIndex(({ track }) => track === item.track) === itemIndex);
    if (!active.length) continue;
    const previous = segments.at(-1);
    if (previous && previous.endMs === startMs && segmentKey(previous.cues) === segmentKey(active)) {
      previous.endMs = endMs;
    } else {
      segments.push({ startMs, endMs, cues: active });
    }
  }
  return segments;
}

export function findSubtitleRenderSegment(cues: SubtitleCue[], currentMs: number) {
  return buildSubtitleRenderSegments(cues)
    .find((segment) => segment.startMs <= currentMs && currentMs < segment.endMs);
}
