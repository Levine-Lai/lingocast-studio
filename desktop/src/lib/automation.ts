import { normalizeSubtitleStyle, normalizeSubtitleStyleOverride, type SubtitleCue } from "../types";

export function automationCues(value: unknown): SubtitleCue[] {
  if (!Array.isArray(value)) throw new Error("cues must be an array");
  const ids = new Set<string>();
  return value.map((item, position) => {
    if (!item || typeof item !== "object") throw new Error(`Invalid cue ${position}`);
    const { startMs, endMs, sourceText = "", targetText = "", speaker = "" } = item;
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || endMs <= startMs) {
      throw new Error(`Invalid timing at cue ${position}`);
    }
    if (![sourceText, targetText, speaker].every((v) => typeof v === "string")) throw new Error("Cue text must be strings");
    const id = item.id ?? crypto.randomUUID();
    if (typeof id !== "string" || !id || ids.has(id)) throw new Error("Cue ids must be unique strings");
    ids.add(id);
    return { id, position, startMs, endMs, sourceText, targetText, speaker,
      status: ["draft", "reviewed", "approved"].includes(item.status) ? item.status : "draft",
      kind: item.kind === "note" ? "note" : "subtitle",
      subtitleStyle: normalizeSubtitleStyleOverride(item.subtitleStyle),
    };
  });
}

export { normalizeSubtitleStyle };
