import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBundledTool } from '../binaries';
import { parseFfprobeJson, probeVideo } from './ffprobe';

const directories: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dance-library-probe-'));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseFfprobeJson', () => {
  it('reads duration, codec, size, and creation time from the video stream', () => {
    const parsed = parseFfprobeJson({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'mjpeg',
          width: 120,
          height: 80,
          disposition: { attached_pic: 1 },
        },
        {
          codec_type: 'video',
          codec_name: 'hevc',
          width: 1920,
          height: 1080,
          tags: { rotate: '90' },
          side_data_list: [{ rotation: -90 }],
        },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
      format: {
        duration: '12.5',
        tags: { creation_time: '2024-06-01T15:04:05.000000Z' },
      },
    });
    expect(parsed).toEqual({
      durationMs: 12500,
      width: 1080,
      height: 1920,
      videoCodec: 'hevc',
      metadataCreatedAt: '2024-06-01T15:04:05.000Z',
      error: null,
    });
  });

  it('reports a file with no video stream', () => {
    expect(parseFfprobeJson({ streams: [{ codec_type: 'audio', codec_name: 'aac' }] }).error).toBe(
      'No video stream',
    );
  });

  it('ignores an epoch creation time', () => {
    const parsed = parseFfprobeJson({
      streams: [{ codec_type: 'video', codec_name: 'h264', width: 16, height: 16 }],
      format: { duration: 1, tags: { creation_time: '1970-01-01T00:00:00Z' } },
    });
    expect(parsed.metadataCreatedAt).toBeNull();
    expect(parsed.videoCodec).toBe('h264');
    expect(parsed.error).toBeNull();
  });
});

describe('probeVideo', () => {
  it('probes a generated h264 sample', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'sample.mp4');
    const ffmpeg = resolveBundledTool('ffmpeg');
    const made = spawnSync(
      ffmpeg,
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=160x120:rate=10:duration=0.6',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-an',
        '-metadata',
        'creation_time=2024-06-01T15:04:05Z',
        file,
      ],
      { encoding: 'utf8' },
    );
    expect(made.status, made.stderr).toBe(0);

    const probed = await probeVideo(file);
    expect(probed.error).toBeNull();
    expect(probed.videoCodec).toBe('h264');
    expect(probed.width).toBe(160);
    expect(probed.height).toBe(120);
    expect(probed.durationMs).toBeGreaterThan(0);
    expect(probed.metadataCreatedAt).toBe('2024-06-01T15:04:05.000Z');
  });
});
