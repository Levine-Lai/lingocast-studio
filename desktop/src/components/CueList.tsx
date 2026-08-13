import { memo, useEffect, useRef, useState } from "react";
import type { SubtitleCue } from "../types";
import { formatClock, parseClock } from "../lib/time";
import { normalizeSubtitleEditorText, sanitizeSubtitleInput } from "../lib/srt";

type Props = {
  cues: SubtitleCue[];
  selectedCueId: string | null;
  onSelect: (cueId: string) => void;
  onSeek: (milliseconds: number) => void;
  onUpdate: (cueId: string, patch: Partial<SubtitleCue>) => void;
};

function TimeInput({ label, milliseconds, onCommit }: { label: string; milliseconds: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(() => formatClock(milliseconds, true));

  useEffect(() => setDraft(formatClock(milliseconds, true)), [milliseconds]);

  function commit() {
    const parsed = parseClock(draft);
    if (parsed === null) setDraft(formatClock(milliseconds, true));
    else onCommit(parsed);
  }

  return (
    <input
      aria-label={label}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(formatClock(milliseconds, true));
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export const CueList = memo(function CueList({ cues, selectedCueId, onSelect, onSeek, onUpdate }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selectedCueId) return;
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-cue-id="${selectedCueId}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedCueId]);

  return (
    <section className="cue-list-panel" aria-label="字幕编辑列表">
      <header className="cue-list-header">
        <span>#</span><span>入点 / 出点</span><span>说话人</span><span>英文原文 / 中文字幕</span>
      </header>
      <div className="cue-list-scroll" ref={scrollRef}>
        {cues.map((cue, index) => (
          <article
            key={cue.id}
            data-cue-id={cue.id}
            className={cue.id === selectedCueId ? "cue-row selected" : "cue-row"}
            aria-current={cue.id === selectedCueId ? "true" : undefined}
            onFocus={() => onSelect(cue.id)}
          >
            <button className="cue-index" type="button" onClick={() => { onSelect(cue.id); onSeek(cue.startMs); }}>
              {String(index + 1).padStart(3, "0")}
            </button>
            <div className="cue-time-fields">
              <TimeInput
                label={`第 ${index + 1} 条开始时间`}
                milliseconds={cue.startMs}
                onCommit={(startMs) => onUpdate(cue.id, { startMs })}
              />
              <TimeInput
                label={`第 ${index + 1} 条结束时间`}
                milliseconds={cue.endMs}
                onCommit={(endMs) => onUpdate(cue.id, { endMs })}
              />
            </div>
            <input
              className="speaker-field"
              aria-label={`第 ${index + 1} 条说话人`}
              value={cue.speaker}
              placeholder="说话人"
              onChange={(event) => onUpdate(cue.id, { speaker: event.target.value })}
            />
            <div className="cue-copy-fields">
              <textarea
                aria-label={`第 ${index + 1} 条原文`}
                value={cue.sourceText}
                placeholder="原文字幕"
                rows={2}
                onChange={(event) => onUpdate(cue.id, { sourceText: sanitizeSubtitleInput(event.target.value), status: "draft" })}
                onBlur={(event) => {
                  const sourceText = normalizeSubtitleEditorText(event.currentTarget.value);
                  if (sourceText !== cue.sourceText) onUpdate(cue.id, { sourceText, status: "draft" });
                }}
              />
              <textarea
                aria-label={`第 ${index + 1} 条译文`}
                value={cue.targetText}
                placeholder="翻译字幕（可选）"
                rows={2}
                onChange={(event) => onUpdate(cue.id, { targetText: sanitizeSubtitleInput(event.target.value), status: "draft" })}
                onBlur={(event) => {
                  const targetText = normalizeSubtitleEditorText(event.currentTarget.value);
                  if (targetText !== cue.targetText) onUpdate(cue.id, { targetText, status: "draft" });
                }}
              />
            </div>
          </article>
        ))}
        {!cues.length ? (
          <div className="cue-list-empty"><span>CC</span><p>正在等待自动字幕，或手动导入 SRT</p></div>
        ) : null}
      </div>
    </section>
  );
});
