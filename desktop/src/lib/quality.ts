import type { QualityIssue, SubtitleCue } from "../types";

export function validateCues(cues: SubtitleCue[]): QualityIssue[] {
  const ordered = cues.toSorted((a, b) => a.startMs - b.startMs || a.position - b.position);
  const issues: QualityIssue[] = [];

  ordered.forEach((cue, index) => {
    const durationSeconds = Math.max(0.001, (cue.endMs - cue.startMs) / 1000);
    const visibleLength = `${cue.sourceText}${cue.targetText}`.replace(/\s/g, "").length;
    if (!cue.sourceText.trim()) {
      issues.push({ cueId: cue.id, level: "error", message: "原文为空" });
    }
    if (cue.endMs <= cue.startMs) {
      issues.push({ cueId: cue.id, level: "error", message: "结束时间必须晚于开始时间" });
    }
    if (durationSeconds < 0.5) {
      issues.push({ cueId: cue.id, level: "warning", message: "显示时间短于 0.5 秒" });
    }
    if (visibleLength / durationSeconds > 28) {
      issues.push({ cueId: cue.id, level: "warning", message: "阅读速度可能过快" });
    }
    const next = ordered[index + 1];
    if (next && cue.endMs > next.startMs) {
      issues.push({ cueId: cue.id, level: "error", message: "与下一条字幕时间重叠" });
    }
  });

  return issues;
}
