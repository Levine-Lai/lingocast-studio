export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function formatClock(milliseconds: number, showMillis = false) {
  const safe = Math.max(0, Math.round(milliseconds));
  const totalSeconds = Math.floor(safe / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const base = hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
  return showMillis ? `${base}.${String(safe % 1000).padStart(3, "0")}` : base;
}

export function parseClock(value: string) {
  const normalized = value.trim().replace(",", ".");
  if (!normalized) return null;
  const parts = normalized.split(":");
  if (parts.some((part) => !part || Number.isNaN(Number(part)))) return null;
  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
  return Math.max(0, Math.round(seconds * 1000));
}
