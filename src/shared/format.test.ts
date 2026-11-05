import { describe, expect, it } from 'vitest';
import { thumbnailUrl } from './api';
import {
  formatBytes,
  formatCapturedAt,
  formatDuration,
  formatResolution,
  formatVideoMeta,
} from './format';

describe('formatDuration', () => {
  it('formats clock times and rejects missing values', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(600)).toBe('0:01');
    expect(formatDuration(61_000)).toBe('1:01');
    expect(formatDuration(3_661_000)).toBe('1:01:01');
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
  });
});

describe('formatBytes', () => {
  it('uses binary units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(12 * 1024)).toBe('12 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(null)).toBe('—');
  });
});

describe('formatCapturedAt', () => {
  it('shows UTC instants in local time and leaves zone-less values unchanged', () => {
    expect(formatCapturedAt('2024-03-15T19:30:45')).toBe('2024-03-15 19:30:45');
    const instant = new Date('2024-06-01T15:04:05.000Z');
    const pad = (part: number) => String(part).padStart(2, '0');
    expect(formatCapturedAt('2024-06-01T15:04:05.000Z')).toBe(
      `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())} ${pad(instant.getHours())}:${pad(instant.getMinutes())}:${pad(instant.getSeconds())}`,
    );
    expect(formatCapturedAt('2024-03-15')).toBe('2024-03-15');
    expect(formatCapturedAt('2024-03-15')).not.toMatch(/00:00:00/);
    expect(formatCapturedAt(null)).toBe('—');
  });
});

describe('formatVideoMeta', () => {
  it('joins the technical fields shown on a catalog card', () => {
    expect(
      formatVideoMeta({
        durationMs: 2000,
        width: 640,
        height: 360,
        videoCodec: 'h264',
        capturedAt: '2024-06-01T15:04:05.000Z',
        sizeBytes: 120 * 1024,
      }),
    ).toBe(`0:02 · 640x360 · h264 · ${formatCapturedAt('2024-06-01T15:04:05.000Z')} · 120 KB`);
    expect(formatResolution(null, 10)).toBe('—');
  });
});

describe('thumbnailUrl', () => {
  it('accepts only a catalog thumbnail file name', () => {
    const name = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg';
    expect(thumbnailUrl(name)).toBe(`dance-thumb://thumbs/${name}`);
    expect(thumbnailUrl('../secret.jpg')).toBeNull();
    expect(thumbnailUrl(null)).toBeNull();
  });
});
