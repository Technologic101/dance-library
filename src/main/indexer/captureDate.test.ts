import { describe, expect, it } from 'vitest';
import {
  captureDateFromFilename,
  chooseCaptureDate,
  fileTimeIso,
  parseMediaTimestamp,
  wallClockToUtc,
} from './captureDate';

describe('parseMediaTimestamp', () => {
  it('normalizes ffprobe and QuickTime timestamps', () => {
    expect(parseMediaTimestamp('2024-06-01T15:04:05.000000Z')).toBe('2024-06-01T15:04:05.000Z');
    expect(parseMediaTimestamp('2024-06-01T15:04:05+0000')).toBe('2024-06-01T15:04:05.000Z');
  });

  it('rejects the unix epoch and empty values', () => {
    expect(parseMediaTimestamp('1970-01-01T00:00:00.000000Z')).toBeNull();
    expect(parseMediaTimestamp('not a date')).toBeNull();
    expect(parseMediaTimestamp('')).toBeNull();
  });
});

describe('captureDateFromFilename', () => {
  it('reads camera, phone, and date-only names', () => {
    expect(captureDateFromFilename('VID_20240315_142233.mp4')).toBe('2024-03-15T14:22:33');
    expect(captureDateFromFilename('PXL_20240315_142233123.mp4')).toBe('2024-03-15T14:22:33');
    expect(captureDateFromFilename('social_2024-03-15 19.30.45.mov')).toBe('2024-03-15T19:30:45');
    expect(captureDateFromFilename('clip-2024-03-15T19-30-45.mkv')).toBe('2024-03-15T19:30:45');
    expect(captureDateFromFilename('VID-20240315-WA0001.mp4')).toBe('2024-03-15');
    expect(captureDateFromFilename('workshop-2024-03-15.mp4')).toBe('2024-03-15');
  });

  it('rejects impossible calendar dates and names with no date', () => {
    expect(captureDateFromFilename('VID_20240231_142233.mp4')).toBeNull();
    expect(captureDateFromFilename('VID_20230229_142233.mp4')).toBeNull();
    expect(captureDateFromFilename('VID_20240229_101500.mp4')).toBe('2024-02-29T10:15:00');
    expect(captureDateFromFilename('basic-step.mp4')).toBeNull();
  });
});

describe('chooseCaptureDate', () => {
  const modified = new Date('2020-01-02T03:04:05.000Z');

  it('prefers metadata, then the filename, then the file time', () => {
    expect(
      chooseCaptureDate({
        metadataCreatedAt: '2024-06-01T15:04:05.000Z',
        filename: 'VID_20240315_142233.mp4',
        fileCreatedAt: null,
        fileModifiedAt: modified,
      }),
    ).toEqual({ capturedAt: '2024-06-01T15:04:05.000Z', source: 'metadata' });

    expect(
      chooseCaptureDate({
        metadataCreatedAt: null,
        filename: 'VID_20240315_142233.mp4',
        fileCreatedAt: null,
        fileModifiedAt: modified,
      }),
    ).toEqual({ capturedAt: wallClockToUtc('2024-03-15T14:22:33'), source: 'filename' });

    expect(
      chooseCaptureDate({
        metadataCreatedAt: null,
        filename: 'basic-step.mp4',
        fileCreatedAt: new Date('1970-01-01T00:00:00.000Z'),
        fileModifiedAt: modified,
      }),
    ).toEqual({ capturedAt: '2020-01-02T03:04:05.000Z', source: 'file_time' });
  });

  it('uses birth time when it is a real timestamp', () => {
    expect(fileTimeIso(new Date('2019-05-01T00:00:00.000Z'), modified)).toBe(
      '2019-05-01T00:00:00.000Z',
    );
    expect(fileTimeIso(new Date('1970-01-01T00:00:00.000Z'), null)).toBeNull();
  });
});
