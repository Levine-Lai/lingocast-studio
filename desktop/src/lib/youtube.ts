const YOUTUBE_HOSTS = new Set(["youtube.com", "youtu.be"]);

export function youtubeUrlError(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "请粘贴 YouTube 视频链接";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "链接必须以 http:// 或 https:// 开头";
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const isYoutube = YOUTUBE_HOSTS.has(host) || host.endsWith(".youtube.com");
    if (!isYoutube) return "目前仅支持 YouTube 和 youtu.be 链接";
    if (!url.pathname.replaceAll("/", "")) return "链接中没有找到视频地址";
    return "";
  } catch {
    return "请输入有效的 YouTube 视频链接";
  }
}

export function normalizeYoutubeUrl(value: string) {
  return value.trim();
}
