import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBundledTool } from '../binaries';
import { seekSeconds, writeThumbnail } from './thumbnails';

const directories: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dance-library-thumb-'));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('seekSeconds', () => {
  it('stays inside short clips and uses one second otherwise', () => {
    expect(seekSeconds(null)).toBe(0);
    expect(seekSeconds(400)).toBe(0);
    expect(seekSeconds(1000)).toBe(0.5);
    expect(seekSeconds(10_000)).toBe(1);
  });
});

describe('writeThumbnail', () => {
  it('writes a jpeg beside the catalog and does not change the video', async () => {
    const dir = tempDir();
    const video = path.join(dir, 'clip.mp4');
    const thumbs = path.join(dir, 'thumbs');
    const dest = path.join(thumbs, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg');
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
        video,
      ],
      { encoding: 'utf8' },
    );
    expect(made.status, made.stderr).toBe(0);
    const before = fs.readFileSync(video);

    const wrote = await writeThumbnail(video, dest, 600);
    expect(wrote).toBe(true);
    const header = fs.readFileSync(dest).subarray(0, 3);
    expect([...header]).toEqual([0xff, 0xd8, 0xff]);
    expect(fs.readFileSync(video).equals(before)).toBe(true);
    const partial = path.join(path.dirname(dest), `.${path.basename(dest)}.partial.jpg`);
    expect(fs.existsSync(partial)).toBe(false);
  });
});
