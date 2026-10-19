import { describe, expect, it } from "vitest";
import type { SubtitleCue, VideoSegment } from "../types";
import { editedVideoDurationMs, remapCuesToEditedVideo, splitVideoSegment } from "./videoEdits";

const cue = (id: string, startMs: number, endMs: number): SubtitleCue => ({
  id, position: 0, startMs, endMs, speaker: "", sourceText: id, targetText: "", status: "draft",
});

describe("non-destructive video edits", () => {
  it("splits the implicit full video at the playhead", () => {
    let next = 0;
    const result = splitVideoSegment([], 10_000, 4_000, () => `part-${next++}`);
    expect(result.segments).toEqual([
      { id: "part-0", startMs: 0, endMs: 4_000, removed: false },
      { id: "part-1", startMs: 4_000, endMs: 10_000, removed: false },
    ]);
    expect(result.selectedId).toBe("part-1");
  });

  it("compresses kept ranges into the exported timeline", () => {
    const segments: VideoSegment[] = [
      { id: "a", startMs: 0, endMs: 3_000, removed: false },
      { id: "drop", startMs: 3_000, endMs: 6_000, removed: true },
      { id: "b", startMs: 6_000, endMs: 10_000, removed: false },
    ];
    expect(editedVideoDurationMs(segments, 10_000)).toBe(7_000);
    expect(remapCuesToEditedVideo([
      cue("before", 1_000, 2_000),
      cue("removed", 3_500, 4_500),
      cue("after", 7_000, 8_000),
    ], segments, 10_000).map(({ id, startMs, endMs }) => ({ id, startMs, endMs }))).toEqual([
      { id: "before", startMs: 1_000, endMs: 2_000 },
      { id: "after", startMs: 4_000, endMs: 5_000 },
    ]);
  });
});
