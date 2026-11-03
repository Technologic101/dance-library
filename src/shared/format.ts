export function formatDuration(durationMs: number | null): string {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) return '—';
  const total = Math.round(durationMs / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const clock = `${minutes}:${String(seconds).padStart(2, '0')}`;
  if (hours > 0)
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return clock;
}

export function formatBytes(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatResolution(width: number | null, height: number | null): string {
  if (width == null || height == null) return '—';
  return `${width}x${height}`;
}

/** Shows a stored capture timestamp without shifting its wall-clock time. */
export function formatCapturedAt(value: string | null): string {
  if (!value) return '—';
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}:\d{2}))?/.exec(value);
  if (!match) return value;
  const date = match[1];
  const time = match[2];
  if (!date) return value;
  if (!time) return date;
  return `${date} ${time}`;
}

export function formatVideoMeta(video: {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  capturedAt: string | null;
  sizeBytes: number | null;
}): string {
  return [
    formatDuration(video.durationMs),
    formatResolution(video.width, video.height),
    video.videoCodec ?? '—',
    formatCapturedAt(video.capturedAt),
    formatBytes(video.sizeBytes),
  ].join(' · ');
}
