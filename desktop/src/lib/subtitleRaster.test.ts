import { describe, expect, it } from "vitest";
import type { SubtitleCue } from "../types";
import { DEFAULT_NOTE_SUBTITLE_STYLE, DEFAULT_SUBTITLE_STYLE } from "../types";
import { balanceSubtitleLines, buildSubtitleRenderTimeline, findSubtitleRenderCue, trackedSubtitleStyle } from "./subtitleRaster";

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

  it("never splits a protected Chinese term across lines", () => {
    const lines = balanceSubtitleLines(
      "髋关节中，股骨头是“球”，它坐在髋臼这个“窝”里，因此这个关节非常稳定",
      20,
      measure,
    );

    expect(lines).toHaveLength(2);
    expect(lines.join("")).toContain("髋臼");
    expect(lines[0]).not.toMatch(/髋$/u);
    expect(lines[1]).not.toMatch(/^臼/u);
  });

  it("balances mixed Chinese and Latin text while keeping names intact", () => {
    const lines = balanceSubtitleLines(
      "当 Darnold 落地时，所有力量都会沿股骨向上传递，最终进入股骨髋臼关节",
      24,
      measure,
    );

    expect(lines).toHaveLength(2);
    expect(lines.every((line) => !line.includes("Darn old"))).toBe(true);
    expect(Math.abs(measure(lines[0]) - measure(lines[1]))).toBeLessThanOrEqual(4);
  });
});

describe("two-track subtitle styling", () => {
  it("uses the requested centered upper-screen defaults for new annotations", () => {
    expect(DEFAULT_NOTE_SUBTITLE_STYLE).toMatchObject({
      positionX: 50,
      positionY: 80,
      targetColor: "#C2FFF8",
      targetFontFamily: "Microsoft YaHei",
      targetFontSize: 40,
    });
  });

  it("automatically raises an overlapping annotation above the primary subtitle", () => {
    expect(trackedSubtitleStyle({ cue: cue(1, 0, 1_000, "note"), track: 1 }, DEFAULT_SUBTITLE_STYLE).positionY)
      .toBe(DEFAULT_SUBTITLE_STYLE.positionY + 16);
  });

  it("preserves a manually positioned annotation", () => {
    const note = { ...cue(1, 0, 1_000, "note"), subtitleStyle: { positionY: 42 } };
    expect(trackedSubtitleStyle({ cue: note, track: 1 }, DEFAULT_SUBTITLE_STYLE).positionY).toBe(42);
  });
});
