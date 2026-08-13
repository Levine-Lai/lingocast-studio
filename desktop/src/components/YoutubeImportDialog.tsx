import { useEffect, useId, useState } from "react";
import { normalizeYoutubeUrl, youtubeUrlError } from "../lib/youtube";
import { openYoutubeLogin, pickYoutubeCookieFile } from "../lib/platform";
import type { YoutubeDownloadState } from "../types";

const YOUTUBE_COOKIE_PATH_KEY = "lingocast-youtube-cookie-path-v1";
const YOUTUBE_BROWSER_PROFILE_KEY = "lingocast-youtube-browser-profile-v2";

type Props = {
  download: YoutubeDownloadState;
  error: string;
  onClose: () => void;
  onSubmit: (url: string, cookiePath: string, browserProfile: string) => Promise<void>;
};

export function YoutubeImportDialog({ download, error, onClose, onSubmit }: Props) {
  const titleId = useId();
  const descriptionId = useId();
  const [url, setUrl] = useState("");
  const [validationError, setValidationError] = useState("");
  const [cookiePath, setCookiePath] = useState(() => localStorage.getItem(YOUTUBE_COOKIE_PATH_KEY) ?? "");
  const [browserProfile, setBrowserProfile] = useState(() => localStorage.getItem(YOUTUBE_BROWSER_PROFILE_KEY) ?? "");
  const [loginNotice, setLoginNotice] = useState("");

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !download.active) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [download.active, onClose]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const problem = youtubeUrlError(url);
    setValidationError(problem);
    if (problem) return;
    await onSubmit(normalizeYoutubeUrl(url), cookiePath, browserProfile);
  }

  async function chooseCookieFile() {
    const selected = await pickYoutubeCookieFile();
    if (!selected) return;
    setCookiePath(selected);
    localStorage.setItem(YOUTUBE_COOKIE_PATH_KEY, selected);
    setValidationError("");
  }

  function clearCookieFile() {
    setCookiePath("");
    localStorage.removeItem(YOUTUBE_COOKIE_PATH_KEY);
  }

  function chooseBrowser(value: string) {
    setBrowserProfile(value);
    localStorage.setItem(YOUTUBE_BROWSER_PROFILE_KEY, value);
    setLoginNotice("");
  }

  async function loginWithBrowser() {
    if (!browserProfile) return;
    try {
      await openYoutubeLogin(browserProfile);
      setLoginNotice("请在新窗口登录 YouTube，确认可以播放视频后关闭该窗口，再开始下载。以后无需重复登录。");
    } catch (reason) {
      setLoginNotice(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !download.active) onClose();
    }}>
      <section
        className="youtube-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <button className="dialog-close" type="button" onClick={onClose} disabled={download.active} aria-label="关闭">×</button>
        <span className="youtube-mark" aria-hidden="true">▶</span>
        <h2 id={titleId}>从 YouTube 导入视频</h2>
        <p id={descriptionId}>粘贴单个视频链接。应用会下载视频、整理英文断句，并通过 DeepSeek 生成中文字幕。</p>

        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="youtube-url">YouTube 视频网址</label>
          <div className={validationError || error ? "url-input invalid" : "url-input"}>
            <span aria-hidden="true">↗</span>
            <input
              id="youtube-url"
              type="url"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setValidationError("");
              }}
              placeholder="https://www.youtube.com/watch?v=..."
              autoFocus
              autoComplete="off"
              disabled={download.active}
              aria-invalid={Boolean(validationError || error)}
            />
          </div>
          {validationError || error ? <p className="dialog-error" role="alert">{validationError || error}</p> : null}

          <div className="youtube-cookie-card">
            <div>
              <strong>长期登录方式</strong>
              <small>使用 LingoCast 专用浏览器档案。首次登录并关闭窗口后，软件会持续复用，不必反复导出 Cookie。</small>
            </div>
            <div className="youtube-browser-auth">
              <select
                value={browserProfile}
                onChange={(event) => chooseBrowser(event.target.value)}
                disabled={download.active || Boolean(cookiePath)}
                aria-label="YouTube 登录浏览器"
              >
                <option value="">自动匿名下载（推荐）</option>
                <option value="edge">Microsoft Edge 专用档案</option>
                <option value="chrome">Google Chrome 专用档案</option>
              </select>
              <button type="button" onClick={() => void loginWithBrowser()} disabled={download.active || Boolean(cookiePath) || !browserProfile}>
                打开/刷新登录
              </button>
            </div>
            {loginNotice ? <small className="youtube-login-notice" role="status">{loginNotice}</small> : null}
            <div className="youtube-cookie-separator"><span>备用方式</span></div>
            <div className="youtube-cookie-actions">
              <button type="button" onClick={() => void chooseCookieFile()} disabled={download.active}>
                {cookiePath ? "更换 cookies.txt" : "选择 cookies.txt"}
              </button>
              {cookiePath ? <button type="button" onClick={clearCookieFile} disabled={download.active}>清除</button> : null}
            </div>
            {cookiePath ? <code title={cookiePath}>{cookiePath.split(/[\\/]/).pop()}</code> : null}
          </div>

          {download.active ? (
            <div className="download-progress" role="status" aria-live="polite">
              <div><strong>{download.status}</strong><span>{Math.round(download.percent)}%</span></div>
              <progress max="100" value={download.percent} />
              <small>{download.detail || "正在准备下载…"}</small>
            </div>
          ) : null}

          <div className="dialog-actions">
            <button type="button" onClick={onClose} disabled={download.active}>取消</button>
            <button className="youtube-submit" type="submit" disabled={download.active || !url.trim()}>
              {download.active ? "正在导入…" : "下载并创建项目"}
            </button>
          </div>
        </form>
        <small className="dialog-note">DeepSeek 翻译使用本机配置；暂不支持播放列表。</small>
      </section>
    </div>
  );
}
