import { describe, expect, it } from "vitest";
import { resolveBurnDurationMs } from "./platform";
import type { SubtitleCue } from "../types";

const cue = (endMs: number): SubtitleCue => ({
  id: String(endMs),
  position: 0,
  startMs: 0,
  endMs,
  speaker: "",
  sourceText: "subtitle",
  targetText: "字幕",
  status: "draft",
});

describe("burn duration", () => {
  it("uses the furthest cue instead of trusting cue order or pending metadata", () => {
    expect(resolveBurnDurationMs([cue(8_000), cue(24_000), cue(12_000)], 0)).toBe(24_000);
  });

  it("keeps a valid media duration when it exceeds the subtitle timeline", () => {
    expect(resolveBurnDurationMs([cue(5_000)], 10_000)).toBe(10_000);
  });

  it("rejects non-finite metadata by falling back to subtitle timing", () => {
    expect(resolveBurnDurationMs([cue(7_000)], Number.NaN)).toBe(7_000);
  });
});
