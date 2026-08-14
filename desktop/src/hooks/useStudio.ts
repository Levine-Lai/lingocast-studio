import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { normalizeSubtitleStyle, normalizeSubtitleStyleOverride, type ProjectSummary, type StudioProject, type SubtitleCue } from "../types";
import { createProject, deleteProject, listProjects, loadProject, saveProject } from "../lib/repository";
import { isTauri, localVideoUrl } from "../lib/platform";
import { normalizeSubtitleEditorText } from "../lib/srt";
import { transitionHistoryGroup, type HistoryUpdateOptions } from "../lib/historyGroup";

function normalizePositions(cues: SubtitleCue[]) {
  return cues
    .toSorted((a, b) => a.startMs - b.startMs || a.position - b.position)
    .map((cue, position) => ({ ...cue, position }));
}

async function hydrateProject(loaded: StudioProject | null) {
  if (loaded) {
    const subtitleStyle = normalizeSubtitleStyle({
      ...loaded.subtitleStyle,
      // 0.7.0 的默认描边在缩放预览中显得过重，自动恢复为此前的无描边样式。
      outlineWidth: loaded.subtitleStyle?.outlineWidth === 1.5 ? 0 : loaded.subtitleStyle?.outlineWidth,
    });
    const cues = loaded.cues.map((cue) => ({
      ...cue,
      sourceText: normalizeSubtitleEditorText(cue.sourceText),
      targetText: normalizeSubtitleEditorText(cue.targetText),
      subtitleStyle: normalizeSubtitleStyleOverride(cue.subtitleStyle),
    }));
    const changed = cues.some((cue, index) => cue.sourceText !== loaded!.cues[index].sourceText
      || cue.targetText !== loaded!.cues[index].targetText
      || JSON.stringify(cue.subtitleStyle) !== JSON.stringify(loaded!.cues[index].subtitleStyle))
      || JSON.stringify(subtitleStyle) !== JSON.stringify(loaded.subtitleStyle);
    if (changed) loaded = await saveProject({ ...loaded, cues, subtitleStyle });
  }
  if (loaded && isTauri()) {
    try {
      loaded.videoUrl = await localVideoUrl(loaded.videoPath);
    } catch {
      // Keep a project editable when its original media was moved. Export will
      // still give a precise missing-file error instead of blocking the studio.
      loaded.videoUrl = undefined;
    }
  }
  return loaded;
}

export function useStudio() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<StudioProject | null>(null);
  const [selectedCueId, setSelectedCueId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const undoStack = useRef<StudioProject[]>([]);
  const redoStack = useRef<StudioProject[]>([]);
  const activeHistoryGroup = useRef<string | null>(null);

  const refreshProjects = useCallback(async () => {
    setProjects(await listProjects());
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([listProjects()])
      .then(async ([saved]) => {
        if (!active) return;
        setProjects(saved);
        if (saved[0]) setProject(await hydrateProject(await loadProject(saved[0].id)));
      })
      .catch((reason: unknown) => active && setError(reason instanceof Error ? reason.message : "无法读取本地项目"))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  const chooseProject = useCallback(async (projectId: string) => {
    try {
      setLoading(true);
      if (project && dirty) await saveProject(project);
      const loaded = await hydrateProject(await loadProject(projectId));
      setProject(loaded);
      setSelectedCueId(null);
      setDirty(false);
      undoStack.current = [];
      redoStack.current = [];
      activeHistoryGroup.current = null;
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法打开项目");
    } finally {
      setLoading(false);
    }
  }, [dirty, project]);

  const removeProject = useCallback(async (projectId: string) => {
    try {
      setLoading(true);
      const removedIndex = projects.findIndex((item) => item.id === projectId);
      await deleteProject(projectId);
      const remaining = await listProjects();
      setProjects(remaining);
      if (project?.id === projectId) {
        const replacement = remaining[Math.min(Math.max(0, removedIndex), remaining.length - 1)] ?? null;
        setProject(replacement ? await hydrateProject(await loadProject(replacement.id)) : null);
        setSelectedCueId(null);
        setDirty(false);
        undoStack.current = [];
        redoStack.current = [];
        activeHistoryGroup.current = null;
      }
      setError("");
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法删除项目");
      return false;
    } finally {
      setLoading(false);
    }
  }, [project?.id, projects]);

  const addProject = useCallback(async (
    input: { name: string; videoPath: string; videoUrl?: string; sourceContext?: StudioProject["sourceContext"] },
    initialCues: SubtitleCue[] = [],
  ) => {
    try {
      const created = await createProject(input);
      const prepared = initialCues.length
        ? await saveProject({ ...created, cues: normalizePositions(initialCues) })
        : created;
      setProject(prepared);
      setDirty(false);
      setSelectedCueId(prepared.cues[0]?.id ?? null);
      undoStack.current = [];
      redoStack.current = [];
      activeHistoryGroup.current = null;
      await refreshProjects();
      return prepared;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法创建项目");
      return null;
    }
  }, [refreshProjects]);

  const updateProject = useCallback((
    updater: (current: StudioProject) => StudioProject,
    options: HistoryUpdateOptions = {},
  ) => {
    setProject((current) => {
      if (!current) return current;
      const history = transitionHistoryGroup(activeHistoryGroup.current, options.historyGroup);
      activeHistoryGroup.current = history.activeGroup;
      if (history.shouldRecord) {
        undoStack.current.push(current);
        if (undoStack.current.length > 100) undoStack.current.shift();
      }
      redoStack.current = [];
      return updater(current);
    });
    setDirty(true);
  }, []);

  const replaceCues = useCallback((cues: SubtitleCue[]) => {
    updateProject((current) => ({ ...current, cues: normalizePositions(cues) }));
    setSelectedCueId(cues[0]?.id ?? null);
  }, [updateProject]);

  const updateCue = useCallback((cueId: string, patch: Partial<SubtitleCue>, options: HistoryUpdateOptions = {}) => {
    updateProject((current) => ({
      ...current,
      cues: normalizePositions(current.cues.map((cue) => cue.id === cueId ? { ...cue, ...patch } : cue)),
    }), options);
  }, [updateProject]);

  const replaceCuesAndSave = useCallback(async (cues: SubtitleCue[]) => {
    if (!project) return null;
    try {
      setSaving(true);
      const next = { ...project, cues: normalizePositions(cues) };
      const saved = await saveProject(next);
      setProject(saved);
      setSelectedCueId(saved.cues[0]?.id ?? null);
      setDirty(false);
      undoStack.current = [];
      redoStack.current = [];
      activeHistoryGroup.current = null;
      await refreshProjects();
      return saved;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存字幕失败");
      return null;
    } finally {
      setSaving(false);
    }
  }, [project, refreshProjects]);

  const undo = useCallback(() => {
    activeHistoryGroup.current = null;
    setProject((current) => {
      const previous = undoStack.current.pop();
      if (!current || !previous) return current;
      redoStack.current.push(current);
      setSelectedCueId((selected) => previous.cues.some((cue) => cue.id === selected)
        ? selected
        : previous.cues[0]?.id ?? null);
      setDirty(true);
      return previous;
    });
  }, []);

  const redo = useCallback(() => {
    activeHistoryGroup.current = null;
    setProject((current) => {
      const next = redoStack.current.pop();
      if (!current || !next) return current;
      undoStack.current.push(current);
      setSelectedCueId((selected) => next.cues.some((cue) => cue.id === selected)
        ? selected
        : next.cues[0]?.id ?? null);
      setDirty(true);
      return next;
    });
  }, []);

  const save = useCallback(async () => {
    if (!project || saving) return;
    try {
      setSaving(true);
      const saved = await saveProject(project);
      setProject(saved);
      setDirty(false);
      await refreshProjects();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }, [project, refreshProjects, saving]);

  const markBurned = useCallback(async () => {
    if (!project) return null;
    try {
      setSaving(true);
      const saved = await saveProject({ ...project, burnedAt: new Date().toISOString() });
      setProject(saved);
      setDirty(false);
      await refreshProjects();
      return saved;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法保存已烧录状态");
      return null;
    } finally {
      setSaving(false);
    }
  }, [project, refreshProjects]);

  useEffect(() => {
    if (!project || !dirty || saving) return;
    const snapshot = project;
    const timer = window.setTimeout(() => {
      setSaving(true);
      void saveProject(snapshot)
        .then(async (saved) => {
          setProject((current) => {
            if (current !== snapshot) return current;
            setDirty(false);
            return saved;
          });
          await refreshProjects();
        })
        .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "自动保存失败"))
        .finally(() => setSaving(false));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [dirty, project, refreshProjects, saving]);

  const selectedCue = useMemo(
    () => project?.cues.find((cue) => cue.id === selectedCueId) ?? null,
    [project, selectedCueId],
  );

  return {
    projects,
    project,
    selectedCue,
    selectedCueId,
    loading,
    saving,
    dirty,
    error,
    setError,
    setSelectedCueId,
    chooseProject,
    removeProject,
    addProject,
    updateProject,
    replaceCues,
    replaceCuesAndSave,
    updateCue,
    undo,
    redo,
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
    save,
    markBurned,
  };
}
