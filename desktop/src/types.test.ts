import { describe, expect, it } from "vitest";
import { normalizeSubtitleStyle, normalizeSubtitleStyleOverride } from "./types";

describe("subtitle style sizing", () => {
  it("preserves valid English and Chinese font sizes", () => {
    const style = normalizeSubtitleStyle({ sourceFontSize: 72, targetFontSize: 64 });
    expect(style.sourceFontSize).toBe(72);
    expect(style.targetFontSize).toBe(64);
  });

  it("clamps font sizes to the supported editor range", () => {
    const style = normalizeSubtitleStyle({ sourceFontSize: 8, targetFontSize: 160 });
    expect(style.sourceFontSize).toBe(18);
    expect(style.targetFontSize).toBe(96);
  });

  it("keeps only explicitly overridden properties for one cue", () => {
    expect(normalizeSubtitleStyleOverride({ sourceFontSize: 70, backgroundEnabled: false })).toEqual({
      sourceFontSize: 70,
      backgroundEnabled: false,
    });
    expect(normalizeSubtitleStyleOverride({})).toBeUndefined();
  });
});
