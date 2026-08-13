import type { ProjectSummary } from "../types";
import { formatClock } from "../lib/time";
import appIcon from "../assets/lingocast-app-icon.png";

type Props = {
  projects: ProjectSummary[];
  selectedId?: string;
  onChoose: (id: string) => void;
  onDelete: (id: string, name: string) => void;
  onImportVideo: () => void;
  onImportYoutube: () => void;
  collapsed: boolean;
  onToggle: () => void;
};

export function ProjectSidebar({ projects, selectedId, onChoose, onDelete, onImportVideo, onImportYoutube, collapsed, onToggle }: Props) {
  return (
    <aside className={collapsed ? "project-sidebar collapsed" : "project-sidebar"}>
      <button
        className="sidebar-toggle"
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? "展开项目栏" : "收起项目栏"}
        title={collapsed ? "展开项目栏" : "收起项目栏"}
      >
        {collapsed ? "›" : "‹"}
      </button>
      <div className="brand-block">
        <img className="brand-mark" src={appIcon} alt="" aria-hidden="true" />
        <div className="brand-copy"><strong>LingoCast</strong><small>Subtitle Studio</small></div>
      </div>

      <div className="project-import-actions">
        <button className="new-project-button" type="button" onClick={onImportVideo} title="导入本地视频">
          <span aria-hidden="true">＋</span><span className="project-import-copy">导入本地视频</span>
        </button>
        <button className="youtube-project-button" type="button" onClick={onImportYoutube} title="粘贴 YouTube 网址">
          <span aria-hidden="true">▶</span><span className="project-import-copy">粘贴 YouTube 网址</span>
        </button>
      </div>

      <div className="sidebar-heading">
        <span className="sidebar-heading-copy">本地项目</span><small>{projects.length}</small>
      </div>
      <nav className="project-list" aria-label="本地项目">
        {projects.map((project) => (
          <div className="project-card-row" key={project.id}>
            <button
              className={project.id === selectedId ? "project-card active" : "project-card"}
              type="button"
              onClick={() => onChoose(project.id)}
            >
              <span className="project-thumb" aria-hidden="true">
                ▶
                {project.burnedAt ? <i className="project-burned-check">✓</i> : null}
              </span>
              <span className="project-card-copy">
                <strong>{project.name}</strong>
                <small>{project.cueCount} 条字幕 · {formatClock(project.durationMs)}{project.burnedAt ? <em>✓ 已烧录</em> : null}</small>
              </span>
            </button>
            <button
              className="project-delete"
              type="button"
              aria-label={`删除项目 ${project.name}`}
              title="删除项目（保留原视频文件）"
              onClick={() => {
                if (window.confirm(`确定删除项目「${project.name}」吗？\n\n只删除项目和字幕记录，不会删除原视频文件。`)) onDelete(project.id, project.name);
              }}
            >×</button>
          </div>
        ))}
        {!projects.length ? (
          <div className="project-empty">
            <span aria-hidden="true">◫</span>
            <p>还没有项目</p>
            <small>从本地视频或 YouTube 开始</small>
          </div>
        ) : null}
      </nav>

      <div className="local-badge"><span aria-hidden="true" /><span className="local-badge-copy">所有素材仅保存在本机</span></div>
    </aside>
  );
}
