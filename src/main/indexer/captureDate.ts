export type CaptureDateSource = 'metadata' | 'filename' | 'file_time';

export type ChosenCaptureDate = {
  capturedAt: string | null;
  source: CaptureDateSource | null;
};

const DATE_TIME_PATTERNS: { regex: RegExp; withTime: boolean }[] = [
  {
    regex:
      /(?<y>20\d{2})-(?<m>0[1-9]|1[0-2])-(?<d>0[1-9]|[12]\d|3[01])[T _](?<h>[01]\d|2[0-3])[:._-](?<min>[0-5]\d)[:._-](?<s>[0-5]\d)/,
    withTime: true,
  },
  {
    regex:
      /(?<y>20\d{2})(?<m>0[1-9]|1[0-2])(?<d>0[1-9]|[12]\d|3[01])[-_T ](?<h>[01]\d|2[0-3])(?<min>[0-5]\d)(?<s>[0-5]\d)/,
    withTime: true,
  },
  {
    regex:
      /(?:^|[^0-9])(?<y>20\d{2})(?<m>0[1-9]|1[0-2])(?<d>0[1-9]|[12]\d|3[01])(?<h>[01]\d|2[0-3])(?<min>[0-5]\d)(?<s>[0-5]\d)(?:[^0-9]|$)/,
    withTime: true,
  },
  {
    regex: /(?<y>20\d{2})-(?<m>0[1-9]|1[0-2])-(?<d>0[1-9]|[12]\d|3[01])(?!\d)/,
    withTime: false,
  },
  {
    regex: /(?:^|[^0-9])(?<y>20\d{2})(?<m>0[1-9]|1[0-2])(?<d>0[1-9]|[12]\d|3[01])(?:[^0-9]|$)/,
    withTime: false,
  },
];

/** Parses ffprobe and QuickTime timestamps. Epoch and nonsense years are ignored. */
export function parseMediaTimestamp(value: string): string | null {
  const normalized = value.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  if (!normalized) return null;
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  if (year < 1971 || year > 2100) return null;
  return date.toISOString();
}

/**
 * Wall-clock time from a filename, with no timezone. Returns
 * `YYYY-MM-DDTHH:mm:ss` or `YYYY-MM-DD`.
 */
export function captureDateFromFilename(filename: string): string | null {
  const base = filename.replace(/\.[^.]+$/, '');
  for (const pattern of DATE_TIME_PATTERNS) {
    const match = pattern.regex.exec(base);
    const groups = match?.groups;
    if (!groups?.y || !groups.m || !groups.d) continue;
    const year = Number(groups.y);
    const month = Number(groups.m);
    const day = Number(groups.d);
    const hour = pattern.withTime ? Number(groups.h) : 0;
    const minute = pattern.withTime ? Number(groups.min) : 0;
    const second = pattern.withTime ? Number(groups.s) : 0;
    if (!isCalendarDate(year, month, day, hour, minute, second)) continue;
    const date = `${groups.y}-${groups.m}-${groups.d}`;
    if (!pattern.withTime) return date;
    return `${date}T${groups.h}:${groups.min}:${groups.s}`;
  }
  return null;
}

/** Interprets a zone-less wall clock as local time and stores a UTC instant. */
export function wallClockToUtc(value: string): string {
  if (value.endsWith('Z')) return value;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2}))?/.exec(value);
  if (!match) return value;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4] ?? 0),
    Number(match[5] ?? 0),
    Number(match[6] ?? 0),
  );
  if (!Number.isFinite(date.getTime())) return value;
  return date.toISOString();
}

export function fileTimeIso(birthtime: Date | null, mtime: Date | null): string | null {
  if (birthtime && isReasonableInstant(birthtime)) return birthtime.toISOString();
  if (mtime && isReasonableInstant(mtime)) return mtime.toISOString();
  return null;
}

/**
 * Metadata wins, then a date written into the filename, then the file's own
 * timestamp. Nothing here is written into the user-editable event date.
 */
export function chooseCaptureDate(input: {
  metadataCreatedAt: string | null;
  filename: string;
  fileCreatedAt: Date | null;
  fileModifiedAt: Date | null;
}): ChosenCaptureDate {
  if (input.metadataCreatedAt) {
    return { capturedAt: input.metadataCreatedAt, source: 'metadata' };
  }
  const fromName = captureDateFromFilename(input.filename);
  if (fromName) return { capturedAt: wallClockToUtc(fromName), source: 'filename' };
  const fromFile = fileTimeIso(input.fileCreatedAt, input.fileModifiedAt);
  if (fromFile) return { capturedAt: fromFile, source: 'file_time' };
  return { capturedAt: null, source: null };
}

function isCalendarDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  if (hour > 23 || minute > 59 || second > 59) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function isReasonableInstant(date: Date): boolean {
  const year = date.getUTCFullYear();
  return Number.isFinite(date.getTime()) && year >= 1971 && year <= 2100;
}
