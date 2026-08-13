import { describe, expect, it } from "vitest";
import { applySubtitleCorrections, buildBilingualCues, normalizeSubtitleEditorText, parseSrt, renderSrt, resegmentCues, sanitizeSubtitleInput, sanitizeSubtitleText, splitSubtitleText } from "./srt";

describe("SRT import and export", () => {
  it("parses timestamps and multiline source text", () => {
    const cues = parseSrt(`1
00:00:01,250 --> 00:00:03,500
Hello from
LingoCast.

2
00:00:04,000 --> 00:00:05,000
Second cue.
`);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ startMs: 1250, endMs: 3500, sourceText: "Hello from\nLingoCast" });
  });

  it("removes caption markers, music labels, and the terminal full stop", () => {
    const [cue] = parseSrt(`1
00:00:00,000 --> 00:00:02,000
>> [Music] ♪ Hello world. 你好世界。
`);
    expect(cue.sourceText).toBe("Hello world. 你好世界");
    expect(cue.speaker).toBe("Speaker 1");
  });

  it("keeps intentional editor line breaks and full stops", () => {
    expect(sanitizeSubtitleInput("First line.\nSecond line。\n")).toBe("First line.\nSecond line。\n");
  });

  it("removes only terminal English and Chinese full stops from saved subtitle text", () => {
    expect(sanitizeSubtitleText("I mean, it is organized. Um, yeah.")).toBe("I mean, it is organized. Um, yeah");
    expect(sanitizeSubtitleText("他说：\“谢谢。\”")).toBe("他说：\“谢谢\”");
    expect(sanitizeSubtitleText("自动生成的句尾，")).toBe("自动生成的句尾");
    expect(sanitizeSubtitleText("Automatically generated ending,")).toBe("Automatically generated ending");
    expect(sanitizeSubtitleText("Really? Yes!")).toBe("Really? Yes!");
  });

  it("preserves manually edited terminal punctuation", () => {
    expect(normalizeSubtitleEditorText("我手工输入。。。\n下一行....")).toBe("我手工输入。。。\n下一行....");
    const [cue] = parseSrt("1\n00:00:00,000 --> 00:00:02,000\nPlaceholder");
    cue.sourceText = "Manual ending....";
    cue.targetText = "人工句尾。。。";
    expect(renderSrt([cue])).toContain("Manual ending....\n人工句尾。。。");
  });

  it("applies high-confidence proper-name corrections before translation", () => {
    const [cue] = parseSrt("1\n00:00:00,000 --> 00:00:02,000\nDylan C throws another slider");
    const [corrected] = applySubtitleCorrections([cue], [{ wrong: "Dylan C", correct: "Dylan Cease" }]);
    expect(corrected.sourceText).toBe("Dylan Cease throws another slider");
  });

  it("exports source and optional translation in chronological order", () => {
    const cues = parseSrt(`1
00:00:04,000 --> 00:00:05,000
Later

2
00:00:01,000 --> 00:00:02,000
Earlier
`);
    cues[0].targetText = "稍后";
    const rendered = renderSrt(cues);
    expect(rendered.indexOf("Earlier")).toBeLessThan(rendered.indexOf("Later"));
    expect(rendered).toContain("Later\n稍后");
  });

  it("regroups rolling captions into longer readable phrases", () => {
    const cues = parseSrt(`1
00:00:00,000 --> 00:00:03,960
Three newly promoted teams to the

2
00:00:01,880 --> 00:00:05,880
Premier League in Coventry, Hull, and

3
00:00:03,960 --> 00:00:07,600
Ipswich, and we all need to become

4
00:00:05,880 --> 00:00:09,040
experts in these particularly because of

5
00:00:07,600 --> 00:00:10,880
some nice cheap options for our team.`);

    const regrouped = resegmentCues(cues);

    expect(regrouped.length).toBeLessThan(cues.length);
    expect(regrouped.map((cue) => cue.sourceText).join(" ")).toContain("Three newly promoted teams");
    expect(regrouped.every((cue) => cue.endMs > cue.startMs)).toBe(true);
    expect(regrouped.every((cue, index) => index === 0 || cue.startMs >= regrouped[index - 1].endMs)).toBe(true);
    expect(regrouped.every((cue, index) => index === 0 || cue.startMs >= regrouped[index - 1].endMs)).toBe(true);
  });

  it("never merges subtitles from different speakers", () => {
    const cues = parseSrt(`1
00:00:00,000 --> 00:00:02,000
>> First speaker finishes a complete thought.

2
00:00:02,000 --> 00:00:04,000
>> Second speaker answers immediately.`);
    const regrouped = resegmentCues(cues);
    expect(regrouped).toHaveLength(2);
    expect(regrouped.map((cue) => cue.speaker)).toEqual(["Speaker 1", "Speaker 2"]);
  });

  it("splits English and Chinese independently at the playhead ratio", () => {
    expect(splitSubtitleText("Hello there, welcome back", 0.5)).toEqual(["Hello there,", "welcome back"]);
    expect(splitSubtitleText("你好，欢迎回来", 0.5)).toEqual(["你好，", "欢迎回来"]);
  });

  it("removes repeated prefixes from rolling YouTube captions", () => {
    const cues = parseSrt(`1
00:00:00,000 --> 00:00:02,000
We are building a local subtitle editor

2
00:00:01,000 --> 00:00:03,500
We are building a local subtitle editor that stays in sync

3
00:00:03,000 --> 00:00:05,500
subtitle editor that stays in sync with the speaker`);
    const text = resegmentCues(cues).map((cue) => cue.sourceText).join(" ");
    expect(text.match(/We are building/g)).toHaveLength(1);
    expect(text.match(/subtitle editor/g)).toHaveLength(1);
    expect(text).toContain("that stays in sync with the speaker");
  });

  it("starts a new cue after a long speech pause even without punctuation", () => {
    const cues = parseSrt(`1
00:00:00,000 --> 00:00:01,000
That is the first idea

2
00:00:02,200 --> 00:00:04,200
Now let us move to the budget`);
    const regrouped = resegmentCues(cues);
    expect(regrouped.map((cue) => cue.sourceText)).toEqual([
      "That is the first idea",
      "Now let us move to the budget",
    ]);
  });

  it("splits continuous long speech at a natural clause boundary", () => {
    const cues = parseSrt(`1
00:00:00,000 --> 00:00:10,000
We wanted to explain the plan in more detail because the first version was confusing for everyone involved and the second version needs a much clearer structure`);
    const regrouped = resegmentCues(cues);
    expect(regrouped.length).toBeGreaterThan(1);
    expect(regrouped.every((cue) => cue.sourceText.length <= 88)).toBe(true);
    expect(regrouped.map((cue) => cue.sourceText).join(" ")).toBe("We wanted to explain the plan in more detail because the first version was confusing for everyone involved and the second version needs a much clearer structure");
    expect(regrouped[0].sourceText.endsWith("and")).toBe(false);
  });

  it("does not merge a short remainder back into an overlong timed cue", () => {
    const cues = parseSrt(`1
00:00:00,000 --> 00:00:07,873
had his three highest pull air rate seasons in 2019 it was 27.3% in 2018 it was 25.6%`);
    const regrouped = resegmentCues(cues);
    expect(regrouped.length).toBeGreaterThan(1);
    expect(regrouped.every((cue) => cue.endMs - cue.startMs <= 6_500)).toBe(true);
    expect(regrouped.map((cue) => cue.sourceText).join(" ")).toBe("had his three highest pull air rate seasons in 2019 it was 27.3% in 2018 it was 25.6%");
  });
});

describe("buildBilingualCues", () => {
  it("merges English and Chinese tracks by overlapping time", () => {
    const english = `1\n00:00:01,000 --> 00:00:03,000\nHello world\n\n2\n00:00:03,100 --> 00:00:05,000\nHow are you?`;
    const chinese = `1\n00:00:01,050 --> 00:00:02,950\n你好，世界\n\n2\n00:00:03,000 --> 00:00:05,100\n你好吗？`;
    const cues = buildBilingualCues([
      { language: "zh-Hans", content: chinese },
      { language: "en-orig", content: english },
    ]);
    expect(cues.map((cue) => [cue.sourceText, cue.targetText])).toEqual([
      ["Hello world How are you?", "你好，世界 你好吗？"],
    ]);
    expect(cues[0].startMs).toBe(1_160);
  });
});
