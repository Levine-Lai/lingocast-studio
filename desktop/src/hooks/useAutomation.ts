import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import type { useStudio } from "./useStudio";
import { automationCues, normalizeSubtitleStyle } from "../lib/automation";
import { createProject, listProjects, loadProject, saveProject } from "../lib/repository";
import { burnSubtitleVideo, downloadYoutubeVideo, isTauri, localVideoUrl, translateSubtitleCues } from "../lib/platform";
import { buildBilingualCues, parseSrt, renderSrt, resegmentCues } from "../lib/srt";
import { remapCuesToEditedVideo } from "../lib/videoEdits";
import type { StudioProject } from "../types";

type Request = { id: string; action: string; deadline: number; params?: Record<string, unknown> };
const actions = ["status", "list", "get", "open", "delete", "import", "youtube", "replace-cues", "style", "segments", "translate", "srt", "burn"];

export function useAutomation(studio: ReturnType<typeof useStudio>, busy: boolean) {
  const latest = useRef({ studio, busy });
  latest.current = { studio, busy };
  useEffect(() => {
    if (!isTauri()) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      try {
        const request = await invoke<Request | null>("automation_next");
        if (request) {
          let response: unknown;
          try {
            if (!Number.isFinite(request.deadline) || Date.now() > request.deadline) throw new Error("Request expired; it was not executed");
            const result = await execute(request);
            response = { ok: true, result };
          } catch (error) {
            response = { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
          await invoke("automation_reply", { id: request.id, response });
        }
      } catch {
        // Disabled in normal launches. Do not poll or create files in that mode.
        return;
      }
      if (!stopped) timer = setTimeout(tick, 250);
    }
    async function execute({ action, params: p = {} }: Request): Promise<unknown> {
      const { studio: current, busy: working } = latest.current;
      if (action === "status") return { version: await getVersion(), actions, busy: working || current.loading || current.saving, dirty: current.dirty, projectId: current.project?.id };
      if (!actions.includes(action)) throw new Error(`Unknown action: ${action}`);
      if (working || current.loading || current.saving || current.dirty) throw new Error("Editor busy or has unsaved changes; save and retry");
      if (action === "list") return listProjects();
      if (action === "import" || action === "youtube") {
        let videoPath = String(p.videoPath || "");
        let name = String(p.name || "Imported video");
        let cues = p.cues === undefined
          ? resegmentCues(parseSrt(String(p.srt || ""))).filter((cue) => cue.sourceText.trim())
          : automationCues(p.cues).filter((cue) => cue.sourceText.trim() || cue.targetText.trim());
        let sourceContext: StudioProject["sourceContext"] = {
          title: name,
          channel: "",
          description: "",
          verifiedTerms: [],
        };
        if (action === "youtube") {
          const downloaded = await downloadYoutubeVideo(String(p.url || ""), "", "", () => undefined);
          videoPath = downloaded.path;
          name = downloaded.name;
          cues = buildBilingualCues(downloaded.subtitles);
          sourceContext = downloaded.sourceContext;
        }
        await localVideoUrl(videoPath);
        const durationMs = await invoke<number>("automation_duration", { path: videoPath });
        if (cues.some((cue) => cue.endMs > durationMs)) throw new Error("Cue extends beyond source duration");
        cues = cues.map((cue) => ({ ...cue, id: crypto.randomUUID() }));
        const created = await createProject({ name, videoPath, sourceContext });
        await saveProject({ ...created, cues, durationMs });
        await current.refreshProjects();
        await current.chooseProject(created.id);
        return { projectId: created.id, cueCount: cues.length };
      }
      const id = String(p.projectId || current.project?.id || "");
      const project = await loadProject(id);
      if (!project) throw new Error("Project not found; supply projectId");
      if (action === "get") return project;
      if (action === "delete") {
        if (!p.projectId) throw new Error("delete requires an explicit projectId");
        if (!await current.removeProject(id)) throw new Error("Could not delete project");
        return { projectId: id, deleted: true };
      }
      if (action === "open") { await current.chooseProject(id); return { projectId: id }; }
      if (action === "srt") return renderSrt(remapCuesToEditedVideo(project.cues, project.videoSegments, project.durationMs));
      let next = project;
      if (action === "replace-cues") next = { ...project, cues: automationCues(p.cues).map((cue) => ({ ...cue, id: crypto.randomUUID() })), burnedAt: undefined };
      if (action === "style") {
        if (!p.style || typeof p.style !== "object") throw new Error("style must be an object");
        next = { ...project, subtitleStyle: normalizeSubtitleStyle({ ...project.subtitleStyle, ...p.style }), burnedAt: undefined };
      }
      if (action === "segments") {
        if (!Array.isArray(p.segments)) throw new Error("segments must be an array");
        let end = 0;
        const segments = p.segments.map((segment, index) => {
          if (!segment || !Number.isSafeInteger(segment.startMs) || !Number.isSafeInteger(segment.endMs)
            || segment.startMs !== end || segment.endMs <= end || segment.endMs > project.durationMs || typeof segment.removed !== "boolean") throw new Error("Segments must partition the full source duration");
          end = segment.endMs;
          return { id: crypto.randomUUID() + index, startMs: segment.startMs, endMs: end, removed: segment.removed };
        });
        if (segments.length && (end !== project.durationMs || segments.every((segment) => segment.removed))) throw new Error("Keep at least one segment and cover the full duration");
        next = { ...project, videoSegments: segments, burnedAt: undefined };
      }
      if (action === "translate") next = { ...project, cues: await translateSubtitleCues(project.cues, project.sourceContext), burnedAt: undefined };
      if (action === "burn") {
        if (typeof p.outputPath !== "string" || !/^(?:[a-z]:[\\/]|\\\\).+\.mp4$/i.test(p.outputPath)) throw new Error("Supply an absolute MP4 outputPath");
        if (p.outputPath.replaceAll("/", "\\").toLowerCase() === project.videoPath.replaceAll("/", "\\").toLowerCase()) throw new Error("Output must differ from source video");
        const result = await burnSubtitleVideo(project, () => undefined, p.outputPath);
        await saveProject({ ...project, burnedAt: new Date().toISOString() });
        await current.chooseProject(id);
        return result;
      }
      await saveProject(next);
      await current.refreshProjects();
      await current.chooseProject(id);
      return { projectId: id, cueCount: next.cues.length };
    }
    timer = setTimeout(tick, 0);
    return () => { stopped = true; clearTimeout(timer); };
  }, []);
}
