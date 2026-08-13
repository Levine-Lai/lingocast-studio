import { describe, expect, it } from "vitest";
import { parseSrt } from "./srt";
import { validateCues } from "./quality";

describe("subtitle quality checks", () => {
  it("flags overlaps and empty source captions", () => {
    const cues = parseSrt(`1
00:00:01,000 --> 00:00:03,000
First cue

2
00:00:02,500 --> 00:00:04,000
Second cue
`);
    cues[1].sourceText = "";
    const messages = validateCues(cues).map((issue) => issue.message);
    expect(messages).toContain("与下一条字幕时间重叠");
    expect(messages).toContain("原文为空");
  });
});
