import { DEFAULT_SUBTITLE_STYLE, normalizeSubtitleStyle, normalizeSubtitleStyleOverride, type ProjectSummary, type StudioProject, type SubtitleCue } from "../types";
import { isTauri } from "./platform";

type ProjectRow = {
  id: string;
  name: string;
  video_path: string;
  duration_ms: number;
  created_at: string;
  updated_at: string;
  burned_at?: string | null;
  subtitle_style?: string;
  source_context?: string;
  cue_count?: number;
};

type CueRow = {
  id: string;
  position: number;
  start_ms: number;
  end_ms: number;
  speaker: string;
  source_text: string;
  target_text: string;
  status: SubtitleCue["status"];
  subtitle_style?: string;
};

type SqlDatabase = Awaited<ReturnType<typeof import("@tauri-apps/plugin-sql").default.load>>;

const BROWSER_STORAGE_KEY = "lingocast-studio-projects-v1";
let databasePromise: Promise<SqlDatabase> | null = null;

function summary(project: StudioProject): ProjectSummary {
  const { cues, videoUrl: _videoUrl, ...rest } = project;
  return { ...rest, cueCount: cues.length };
}

function readBrowserProjects(): StudioProject[] {
  try {
    const projects = JSON.parse(localStorage.getItem(BROWSER_STORAGE_KEY) || "[]") as StudioProject[];
    return projects.map((project) => ({
      ...project,
      subtitleStyle: normalizeSubtitleStyle(project.subtitleStyle),
      cues: project.cues.map((cue) => ({ ...cue, subtitleStyle: normalizeSubtitleStyleOverride(cue.subtitleStyle) })),
    }));
  } catch {
    return [];
  }
}

function writeBrowserProjects(projects: StudioProject[]) {
  const serializable = projects.map(({ videoUrl: _videoUrl, ...project }) => project);
  localStorage.setItem(BROWSER_STORAGE_KEY, JSON.stringify(serializable));
}

async function getDatabase() {
  if (!databasePromise) {
    databasePromise = import("@tauri-apps/plugin-sql").then(({ default: Database }) =>
      Database.load("sqlite:lingocast-studio.db"),
    );
  }
  return databasePromise;
}

function mapProject(row: ProjectRow, cues: SubtitleCue[]): StudioProject {
  let storedStyle: unknown;
  try {
    storedStyle = JSON.parse(row.subtitle_style || "{}");
  } catch {
    storedStyle = {};
  }
  let sourceContext: StudioProject["sourceContext"];
  try {
    sourceContext = JSON.parse(row.source_context || "{}");
  } catch {
    sourceContext = undefined;
  }
  return {
    id: row.id,
    name: row.name,
    videoPath: row.video_path,
    durationMs: Number(row.duration_ms),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    burnedAt: row.burned_at || undefined,
    subtitleStyle: normalizeSubtitleStyle(storedStyle as Partial<StudioProject["subtitleStyle"]>),
    sourceContext,
    cues,
  };
}

export async function listProjects(): Promise<ProjectSummary[]> {
  if (!isTauri()) {
    return readBrowserProjects().map(summary).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  const db = await getDatabase();
  const rows = await db.select<ProjectRow[]>(`
    SELECT p.*, pc.source_context, COUNT(c.id) AS cue_count
    FROM projects p
    LEFT JOIN project_contexts pc ON pc.project_id = p.id
    LEFT JOIN cues c ON c.project_id = p.id
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `);
  return rows.map((row) => ({
    ...mapProject(row, []),
    cueCount: Number(row.cue_count || 0),
  }));
}

export async function deleteProject(projectId: string) {
  if (!isTauri()) {
    writeBrowserProjects(readBrowserProjects().filter((project) => project.id !== projectId));
    return;
  }
  const db = await getDatabase();
  await db.execute("DELETE FROM cues WHERE project_id = $1", [projectId]);
  await db.execute("DELETE FROM jobs WHERE project_id = $1", [projectId]);
  await db.execute("DELETE FROM project_contexts WHERE project_id = $1", [projectId]);
  await db.execute("DELETE FROM projects WHERE id = $1", [projectId]);
}

export async function loadProject(projectId: string): Promise<StudioProject | null> {
  if (!isTauri()) {
    return readBrowserProjects().find((project) => project.id === projectId) ?? null;
  }
  const db = await getDatabase();
  const [row] = await db.select<ProjectRow[]>(`
    SELECT p.*, pc.source_context
    FROM projects p
    LEFT JOIN project_contexts pc ON pc.project_id = p.id
    WHERE p.id = $1
  `, [projectId]);
  if (!row) return null;
  const cueRows = await db.select<CueRow[]>(
    "SELECT * FROM cues WHERE project_id = $1 ORDER BY position ASC",
    [projectId],
  );
  return mapProject(row, cueRows.map((cue) => {
    let storedStyle: unknown;
    try {
      storedStyle = JSON.parse(cue.subtitle_style || "{}");
    } catch {
      storedStyle = {};
    }
    return {
    id: cue.id,
    position: Number(cue.position),
    startMs: Number(cue.start_ms),
    endMs: Number(cue.end_ms),
    speaker: cue.speaker,
    sourceText: cue.source_text,
    targetText: cue.target_text,
    status: cue.status,
    subtitleStyle: normalizeSubtitleStyleOverride(storedStyle as Partial<StudioProject["subtitleStyle"]>),
  };
  }));
}

export async function createProject(input: { name: string; videoPath: string; videoUrl?: string; sourceContext?: StudioProject["sourceContext"] }) {
  const now = new Date().toISOString();
  const project: StudioProject = {
    id: crypto.randomUUID(),
    name: input.name,
    videoPath: input.videoPath,
    videoUrl: input.videoUrl,
    durationMs: 0,
    createdAt: now,
    updatedAt: now,
    burnedAt: undefined,
    subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE },
    sourceContext: input.sourceContext,
    cues: [],
  };
  await saveProject(project);
  return project;
}

export async function saveProject(project: StudioProject) {
  const next = { ...project, updatedAt: new Date().toISOString() };
  if (!isTauri()) {
    const projects = readBrowserProjects();
    const index = projects.findIndex((item) => item.id === next.id);
    if (index >= 0) projects[index] = next;
    else projects.unshift(next);
    writeBrowserProjects(projects);
    return next;
  }

  const db = await getDatabase();
  await db.execute(
    `INSERT INTO projects (id, name, video_path, duration_ms, created_at, updated_at, subtitle_style, burned_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       video_path = excluded.video_path,
       duration_ms = excluded.duration_ms,
       updated_at = excluded.updated_at,
       subtitle_style = excluded.subtitle_style,
       burned_at = excluded.burned_at`,
    [next.id, next.name, next.videoPath, next.durationMs, next.createdAt, next.updatedAt, JSON.stringify(next.subtitleStyle), next.burnedAt ?? null],
  );
  await db.execute(
    `INSERT INTO project_contexts (project_id, source_context)
     VALUES ($1, $2)
     ON CONFLICT(project_id) DO UPDATE SET source_context = excluded.source_context`,
    [next.id, JSON.stringify(next.sourceContext ?? {})],
  );

  for (const cue of next.cues) {
    await db.execute(
      `INSERT INTO cues
        (id, project_id, position, start_ms, end_ms, speaker, source_text, target_text, status, updated_at, subtitle_style)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT(id) DO UPDATE SET
         position = excluded.position,
         start_ms = excluded.start_ms,
         end_ms = excluded.end_ms,
         speaker = excluded.speaker,
         source_text = excluded.source_text,
         target_text = excluded.target_text,
         status = excluded.status,
         updated_at = excluded.updated_at,
         subtitle_style = excluded.subtitle_style`,
      [
        cue.id,
        next.id,
        cue.position,
        cue.startMs,
        cue.endMs,
        cue.speaker,
        cue.sourceText,
        cue.targetText,
        cue.status,
        next.updatedAt,
        JSON.stringify(cue.subtitleStyle ?? {}),
      ],
    );
  }
  if (next.cues.length) {
    const placeholders = next.cues.map((_, index) => `$${index + 2}`).join(", ");
    await db.execute(
      `DELETE FROM cues WHERE project_id = $1 AND id NOT IN (${placeholders})`,
      [next.id, ...next.cues.map((cue) => cue.id)],
    );
  } else {
    await db.execute("DELETE FROM cues WHERE project_id = $1", [next.id]);
  }
  return next;
}
