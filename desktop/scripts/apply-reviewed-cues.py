#!/usr/bin/env python3
"""Replace one project's cues with human-reviewed bilingual units and word timings."""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import unicodedata
import uuid
from difflib import SequenceMatcher
from pathlib import Path


TOKEN = re.compile(r"[^\W_]+(?:['’][^\W_]+)?", re.UNICODE)


def tokens(value: str) -> list[str]:
    result = []
    for item in TOKEN.findall(value):
        normalized = unicodedata.normalize("NFKD", item.lower().replace("’", "'"))
        result.append("".join(char for char in normalized if not unicodedata.combining(char)))
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--reviewed", required=True)
    parser.add_argument("--timings", required=True)
    parser.add_argument("--dry-run", action="store_true")
    options = parser.parse_args()

    reviewed = json.loads(Path(options.reviewed).read_text(encoding="utf-8"))["items"]
    if not reviewed:
        raise SystemExit("Reviewed cues must not be empty")
    timing_items = json.loads(Path(options.timings).read_text(encoding="utf-8"))["words"]
    word_tokens = [tokens(item["text"])[0] if tokens(item["text"]) else "" for item in timing_items]
    cursor = 0
    aligned = []
    for position, item in enumerate(reviewed):
        cue_tokens = tokens(item["en"])
        best = None
        maximum_start = min(len(word_tokens), cursor + 70)
        minimum_length = max(1, int(len(cue_tokens) * 0.7))
        maximum_length = max(minimum_length, int(len(cue_tokens) * 1.35) + 3)
        for candidate_start in range(cursor, maximum_start):
            for candidate_length in range(minimum_length, maximum_length + 1):
                candidate_end = min(len(word_tokens), candidate_start + candidate_length)
                matcher = SequenceMatcher(None, cue_tokens, word_tokens[candidate_start:candidate_end], autojunk=False)
                blocks = [block for block in matcher.get_matching_blocks() if block.size]
                matched = sum(block.size for block in blocks)
                score = (matched / max(1, len(cue_tokens)), matcher.ratio(), -candidate_start)
                if blocks and (best is None or score > best[0]):
                    best = (score, candidate_start, blocks)
        blocks = best[2] if best else []
        coverage = sum(block.size for block in blocks) / max(1, len(cue_tokens))
        if not blocks or coverage < 0.85:
            raise SystemExit(f"Cue {position + 1} alignment coverage is only {coverage:.1%}")
        first = best[1] + blocks[0].b
        last = best[1] + blocks[-1].b + blocks[-1].size - 1
        aligned.append({
            "position": position,
            "startMs": timing_items[first]["startMs"],
            "endMs": timing_items[last]["endMs"],
            "sourceText": item["en"].strip().rstrip(".。"),
            "targetText": item["zh"].strip().rstrip(".。"),
            "coverage": coverage,
        })
        cursor = last + 1

    for index, cue in enumerate(aligned[:-1]):
        next_start = aligned[index + 1]["startMs"]
        gap = next_start - cue["endMs"]
        if gap <= 1_500:
            cue["endMs"] = max(cue["startMs"] + 250, next_start)
        else:
            cue["endMs"] = min(next_start - 600, cue["endMs"] + 280)
    for cue in aligned:
        cue["endMs"] = max(cue["startMs"] + 250, cue["endMs"])

    result = {
        "cueCount": len(aligned),
        "averageCoverage": round(sum(cue["coverage"] for cue in aligned) / len(aligned), 3),
        "lowCoverage": [cue["position"] + 1 for cue in aligned if cue["coverage"] < 0.85],
        "maximumDurationMs": max(cue["endMs"] - cue["startMs"] for cue in aligned),
        "maximumEnglishChars": max(len(cue["sourceText"]) for cue in aligned),
        "maximumChineseChars": max(len(cue["targetText"]) for cue in aligned),
        "longest": sorted(({
            "position": cue["position"] + 1,
            "durationMs": cue["endMs"] - cue["startMs"],
            "englishChars": len(cue["sourceText"]),
            "chineseChars": len(cue["targetText"]),
        } for cue in aligned), key=lambda cue: cue["durationMs"], reverse=True)[:10],
    }
    if not options.dry_run:
        db = sqlite3.connect(options.db)
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("BEGIN IMMEDIATE")
        if not db.execute("SELECT id FROM projects WHERE id=?", (options.project,)).fetchone():
            db.close()
            raise SystemExit("Project does not exist")
        db.execute("DELETE FROM cues WHERE project_id=?", (options.project,))
        now = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()
        has_cue_kind = any(row[1] == "cue_kind" for row in db.execute("PRAGMA table_info(cues)"))
        for cue in aligned:
            columns = "id,project_id,position,start_ms,end_ms,speaker,source_text,target_text,status,updated_at,subtitle_style"
            values = (str(uuid.uuid4()), options.project, cue["position"], cue["startMs"], cue["endMs"], "", cue["sourceText"], cue["targetText"], "draft", now, "{}")
            if has_cue_kind:
                columns += ",cue_kind"
                values += ("subtitle",)
            db.execute(f"INSERT INTO cues ({columns}) VALUES ({','.join('?' for _ in values)})", values)
        db.execute("UPDATE projects SET updated_at=? WHERE id=?", (now, options.project))
        db.commit()
        db.close()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
