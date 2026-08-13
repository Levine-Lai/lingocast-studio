import { describe, expect, it } from "vitest";
import type { SubtitleCue } from "../types";
import { balanceSubtitleLines, buildSubtitleRenderTimeline, findSubtitleRenderCue } from "./subtitleRaster";

function cue(position: number, startMs: number, endMs: number, sourceText: string): SubtitleCue {
  return {
    id: String(position),
    position,
    startMs,
    endMs,
    speaker: "",
    sourceText,
    targetText: "",
    status: "draft",
  };
}

describe("subtitle render timeline", () => {
  it("uses the same first-cue priority for preview and burn when cues overlap", () => {
    const cues = [
      cue(0, 0, 4_000, "first"),
      cue(1, 2_000, 6_000, "second"),
      cue(2, 5_000, 7_000, "third"),
    ];

    const timeline = buildSubtitleRenderTimeline(cues);

    expect(timeline.map(({ sourceText, startMs, endMs }) => ({ sourceText, startMs, endMs }))).toEqual([
      { sourceText: "first", startMs: 0, endMs: 4_000 },
      { sourceText: "second", startMs: 4_000, endMs: 6_000 },
      { sourceText: "third", startMs: 6_000, endMs: 7_000 },
    ]);
    expect(findSubtitleRenderCue(cues, 3_000)?.sourceText).toBe("first");
    expect(findSubtitleRenderCue(cues, 4_000)?.sourceText).toBe("second");
    expect(findSubtitleRenderCue(cues, 6_000)?.sourceText).toBe("third");
  });

  it("removes a cue that is completely covered by an earlier cue", () => {
    const timeline = buildSubtitleRenderTimeline([
      cue(0, 0, 5_000, "visible"),
      cue(1, 1_000, 2_000, "covered"),
    ]);

    expect(timeline.map((item) => item.sourceText)).toEqual(["visible"]);
  });
});

describe("balanced subtitle wrapping", () => {
  const measure = (value: string) => value.length;

  it("rebalances a tiny overflow instead of leaving a very short second line", () => {
    expect(balanceSubtitleLines("This subtitle only has a little extra text", 35, measure)).toEqual([
      "This subtitle only has",
      "a little extra text",
    ]);
  });

  it("avoids leaving a connector at a line edge when another balanced split exists", () => {
    const lines = balanceSubtitleLines("We talked about Dylan Cease and his new hairstyle", 29, measure);
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toMatch(/\b(and|the|to|of)$/i);
    expect(lines[1]).not.toMatch(/^(and|the|to|of)\b/i);
  });

  it("keeps text on one line when it already fits", () => {
    expect(balanceSubtitleLines("Short subtitle", 40, measure)).toEqual(["Short subtitle"]);
  });
});
