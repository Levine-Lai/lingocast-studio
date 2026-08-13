import { describe, expect, it } from "vitest";
import { normalizeYoutubeUrl, youtubeUrlError } from "./youtube";

describe("YouTube URL validation", () => {
  it("accepts regular, short and music links", () => {
    expect(youtubeUrlError("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("");
    expect(youtubeUrlError("https://youtu.be/dQw4w9WgXcQ")).toBe("");
    expect(youtubeUrlError("https://music.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("");
  });

  it("rejects invalid or unrelated links", () => {
    expect(youtubeUrlError("")).toMatch(/粘贴/);
    expect(youtubeUrlError("https://example.com/video")).toMatch(/仅支持/);
    expect(youtubeUrlError("not a url")).toMatch(/有效/);
  });

  it("normalizes surrounding whitespace", () => {
    expect(normalizeYoutubeUrl("  https://youtu.be/video  ")).toBe("https://youtu.be/video");
  });
});
