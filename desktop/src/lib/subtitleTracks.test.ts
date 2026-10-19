import { describe, expect, it } from "vitest";
import type { SubtitleCue } from "../types";
import { assignSubtitleTracks, buildSubtitleRenderSegments } from "./subtitleTracks";

function cue(id: string, position: number, startMs: number, endMs: number): SubtitleCue {
  return { id, position, startMs, endMs, speaker: "", sourceText: id, targetText: "", status: "draft" };
}

describe("two-track subtitle layout", () => {
  it("keeps ordinary sequential subtitles on the primary track", () => {
    expect(assignSubtitleTracks([
      cue("a", 0, 0, 1_000),
      cue("b", 1, 1_000, 2_000),
    ]).map(({ track }) => track)).toEqual([0, 0]);
  });

  it("moves an overlapping annotation to the second track", () => {
    expect(assignSubtitleTracks([
      cue("main", 0, 0, 4_000),
      cue("note", 1, 1_000, 2_500),
    ]).map(({ cue: item, track }) => [item.id, track])).toEqual([
      ["main", 0],
      ["note", 1],
    ]);
  });

  it("keeps an explicit annotation on the note track without requiring overlap", () => {
    const note = { ...cue("note", 0, 0, 2_500), kind: "note" as const };
    expect(assignSubtitleTracks([note]).map(({ track }) => track)).toEqual([1]);
  });

  it("creates render segments that retain both overlapping cues", () => {
    const segments = buildSubtitleRenderSegments([
      cue("main", 0, 0, 4_000),
      cue("note", 1, 1_000, 2_500),
    ]);
    expect(segments.map(({ startMs, endMs, cues }) => ({
      startMs,
      endMs,
      ids: cues.map(({ cue: item }) => item.id),
    }))).toEqual([
      { startMs: 0, endMs: 1_000, ids: ["main"] },
      { startMs: 1_000, endMs: 2_500, ids: ["main", "note"] },
      { startMs: 2_500, endMs: 4_000, ids: ["main"] },
    ]);
  });
});
