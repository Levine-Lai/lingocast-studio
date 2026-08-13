#!/usr/bin/env python3
"""LingoCast local media worker protocol.

The first desktop release uses this process boundary for future yt-dlp,
alignment, transcription, and FFmpeg work. Messages are one JSON object per
line on stdin; responses are one JSON object per line on stdout.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from dataclasses import asdict, dataclass
from typing import Any, TextIO


PROTOCOL_VERSION = 1
PIPELINE_STAGES = (
    "queued",
    "acquiring",
    "extracting_audio",
    "transcribing",
    "aligning",
    "translating",
    "awaiting_review",
    "rendering",
    "verifying",
    "completed",
)


@dataclass(frozen=True)
class DependencyStatus:
    python: bool
    ffmpeg: bool
    ffprobe: bool
    yt_dlp: bool

    @property
    def editor_ready(self) -> bool:
        return self.python

    @property
    def pipeline_ready(self) -> bool:
        return self.ffmpeg and self.ffprobe and self.yt_dlp


def dependency_status() -> DependencyStatus:
    return DependencyStatus(
        python=True,
        ffmpeg=shutil.which("ffmpeg") is not None,
        ffprobe=shutil.which("ffprobe") is not None,
        yt_dlp=shutil.which("yt-dlp") is not None,
    )


def response(message_id: Any, *, result: Any = None, error: str | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"id": message_id, "protocol": PROTOCOL_VERSION}
    if error is not None:
        payload["error"] = {"message": error}
    else:
        payload["result"] = result
    return payload


def handle_message(message: dict[str, Any]) -> dict[str, Any]:
    message_id = message.get("id")
    command = message.get("command")
    if command == "health":
        dependencies = dependency_status()
        return response(
            message_id,
            result={
                "status": "ok",
                "dependencies": asdict(dependencies),
                "editorReady": dependencies.editor_ready,
                "pipelineReady": dependencies.pipeline_ready,
                "stages": PIPELINE_STAGES,
            },
        )
    if command == "pipeline_contract":
        return response(
            message_id,
            result={
                "protocolVersion": PROTOCOL_VERSION,
                "stages": PIPELINE_STAGES,
                "events": ["stage", "progress", "artifact", "warning", "completed", "failed"],
            },
        )
    return response(message_id, error=f"unknown command: {command!r}")


def serve(stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout) -> int:
    for raw_line in stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("request must be a JSON object")
            result = handle_message(request)
        except (json.JSONDecodeError, ValueError) as exc:
            result = response(None, error=str(exc))
        stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
        stdout.flush()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="LingoCast local media worker")
    parser.add_argument("--health", action="store_true", help="print one health response and exit")
    args = parser.parse_args(argv)
    if args.health:
        print(json.dumps(handle_message({"id": "health", "command": "health"}), ensure_ascii=False))
        return 0
    return serve()


if __name__ == "__main__":
    raise SystemExit(main())
