import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBundledTool } from '../binaries';
import { openCatalog } from '../db/catalog';
import { createLibraryService } from '../libraryService';

const directories: string[] = [];
const databases: Database.Database[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dance-library-media-'));
  directories.push(dir);
  return dir;
}

function ffmpeg(args: string[], dest: string): void {
  const binary = resolveBundledTool('ffmpeg');
  const result = spawnSync(binary, ['-y', '-hide_banner', '-loglevel', 'error', ...args, dest], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr || 'ffmpeg failed');
}

function fileDigest(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('real sample videos', () => {
  it('indexes generated videos, then renames and removals, without changing the files', async () => {
    const library = tempDir();
    const thumbs = tempDir();
    const h264 = path.join(library, 'lesson-basic.mp4');
    const hevc = path.join(library, 'demo-hevc.mp4');
    const named = path.join(library, 'social_20240315_193045.mp4');
    ffmpeg(
      [
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
      ],
      h264,
    );
    ffmpeg(
      [
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=176x144:rate=8:duration=0.4',
        '-c:v',
        'libx265',
        '-pix_fmt',
        'yuv420p',
        '-an',
        '-x265-params',
        'log-level=error',
      ],
      hevc,
    );
    ffmpeg(
      [
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=128x96:rate=8:duration=0.4',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-an',
        '-metadata',
        'creation_time=1970-01-01T00:00:00Z',
      ],
      named,
    );
    const before = {
      h264: fileDigest(h264),
      hevc: fileDigest(hevc),
      named: fileDigest(named),
    };

    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    const service = createLibraryService(db, thumbs);
    const added = await service.addPaths([library]);
    expect(added.added).toHaveLength(1);
    expect(added.scan).toMatchObject({ discovered: 3, added: 3, errors: 0 });

    const videos = service.listVideos();
    const byName = new Map(videos.map((video) => [video.filename, video]));
    expect(byName.get('lesson-basic.mp4')).toMatchObject({
      videoCodec: 'h264',
      width: 160,
      height: 120,
      capturedAtSource: 'metadata',
      presence: 'present',
    });
    expect(byName.get('lesson-basic.mp4')?.durationMs).toBeGreaterThan(0);
    expect(byName.get('lesson-basic.mp4')?.thumbnailUrl).toMatch(
      /^dance-thumb:\/\/thumbs\/.+\.jpg$/,
    );
    expect(byName.get('demo-hevc.mp4')?.videoCodec).toBe('hevc');
    expect(byName.get('social_20240315_193045.mp4')).toMatchObject({
      capturedAt: '2024-03-15T19:30:45',
      capturedAtSource: 'filename',
    });
    for (const video of videos) {
      expect(video.thumbnailUrl).toBeTruthy();
      const file = path.join(thumbs, `${video.id}.jpg`);
      expect(fs.existsSync(file)).toBe(true);
      expect([...fs.readFileSync(file).subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    }

    const lesson = byName.get('lesson-basic.mp4');
    if (!lesson) throw new Error('missing lesson');
    db.prepare(
      `UPDATE videos SET title = 'Basic step', notes = 'keep me', favorite = 1 WHERE id = ?`,
    ).run(lesson.id);
    const renamed = path.join(library, 'warmup.mp4');
    fs.renameSync(h264, renamed);
    fs.rmSync(hevc);

    const rescanned = await service.scanAll();
    expect(rescanned.added).toBe(0);
    expect(rescanned.missing).toBe(1);
    const afterVideos = service.listVideos();
    const warmup = afterVideos.find((video) => video.id === lesson.id);
    const missing = afterVideos.find((video) => video.filename === 'demo-hevc.mp4');
    expect(warmup).toMatchObject({
      path: renamed,
      filename: 'warmup.mp4',
      displayTitle: 'Basic step',
      presence: 'present',
    });
    expect(missing?.presence).toBe('missing');
    const kept = db
      .prepare(`SELECT notes, favorite, title FROM videos WHERE id = ?`)
      .get(lesson.id) as {
      notes: string;
      favorite: number;
      title: string;
    };
    expect(kept).toEqual({ notes: 'keep me', favorite: 1, title: 'Basic step' });
    expect(fileDigest(renamed)).toBe(before.h264);
    expect(fileDigest(named)).toBe(before.named);
    expect(fs.existsSync(hevc)).toBe(false);
  }, 30_000);
});
