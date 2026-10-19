import { describe, expect, it } from "vitest";
import { automationCues } from "./automation";

describe("automation cue validation", () => {
  it("rejects invalid timing and duplicate ids before persistence", () => {
    expect(() => automationCues([{ startMs: 100, endMs: 50 }])).toThrow("timing");
    expect(() => automationCues([{ startMs: 0.1, endMs: 50 }])).toThrow("timing");
    const cue = { id: "same", startMs: 0, endMs: 100 };
    expect(() => automationCues([cue, cue])).toThrow("unique");
  });
  it("keeps independent overlapping annotation and subtitle cues", () => {
    const cues = automationCues([
      { startMs: 0, endMs: 1000, sourceText: "Hello", targetText: "你好" },
      { startMs: 0, endMs: 1000, kind: "note", targetText: "背景", subtitleStyle: { positionY: 999 } },
    ]);
    expect(cues[0].id).not.toBe(cues[1].id);
    expect(cues[1].kind).toBe("note");
    expect(cues[1].subtitleStyle?.positionY).toBe(80);
    expect(automationCues([])).toEqual([]);
  });
});
