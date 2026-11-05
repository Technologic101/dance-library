import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openCatalog } from '../db/catalog';
import { scanLibrary, type IndexedStat, type ScanDeps } from './scan';
import { describeWindowsPath, type Mount } from './volumes';

const directories: string[] = [];
const databases: Database.Database[] = [];
const volume = 'vol:a1b2c3d4';
const mounts: Mount[] = [{ volumeId: volume, root: 'D:\\' }];

type FakeFile = {
  path: string;
  size: number;
  mtimeNs: string;
  fileId: string;
  volumeId: string;
  hash: string;
  fullHash: string;
  fileIdStable?: boolean;
};

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dance-library-review-'));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function largeDeps(input: { files: FakeFile[]; directories: string[]; failHash?: Set<string> }): {
  deps: ScanDeps;
  thumbs: Set<string>;
} {
  const thumbs = new Set<string>();
  const fileMap = new Map(input.files.map((file) => [file.path, file]));
  const deps: ScanDeps = {
    listMounts: async () => mounts,
    describePath: (filePath, listed) => describeWindowsPath(filePath, listed),
    isDirectory: (filePath) => input.directories.includes(filePath),
    exists: (filePath) => input.directories.includes(filePath) || fileMap.has(filePath),
    readDirectory: async () => true,
    walkVideos: async function* (root) {
      const prefix = root.endsWith('\\') ? root : `${root}\\`;
      for (const file of input.files) {
        if (file.path.startsWith(prefix)) yield file.path;
      }
    },
    stat: async (filePath) => {
      const file = fileMap.get(filePath);
      if (!file) {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      const stat: IndexedStat = {
        size: file.size,
        mtimeNs: file.mtimeNs,
        mtime: new Date('2024-06-01T00:00:00.000Z'),
        birthtime: null,
        fileId: file.fileId,
        volumeId: file.volumeId,
        fileIdStable: file.fileIdStable !== false,
      };
      return stat;
    },
    hash: async (filePath) => {
      if (input.failHash?.has(filePath)) throw new Error('EBUSY');
      const file = fileMap.get(filePath);
      if (!file) throw new Error('missing');
      return { hash: file.hash, kind: 'test' };
    },
    hashCoversFile: () => false,
    fullHash: async (filePath) => {
      const file = fileMap.get(filePath);
      if (!file) throw new Error('missing');
      return file.fullHash;
    },
    probe: async () => ({
      durationMs: 1000,
      width: 320,
      height: 240,
      videoCodec: 'h264',
      metadataCreatedAt: null,
      error: null,
    }),
    writeThumbnail: async (_file, dest) => {
      thumbs.add(path.basename(dest));
      return true;
    },
    thumbnailExists: (name) => thumbs.has(name),
    now: () => '2024-06-02T00:00:00.000Z',
  };
  return { deps, thumbs };
}

function addLibrary(db: Database.Database): void {
  db.prepare(
    `INSERT INTO libraries (id, path, label, created_at, updated_at)
     VALUES ('lib', 'D:\\dance', 'dance', 't', 't')`,
  ).run();
}

const original: FakeFile = {
  path: 'D:\\dance\\lesson.mp4',
  size: 8_000_000,
  mtimeNs: '10',
  fileId: '1',
  volumeId: volume,
  hash: 'partial-same',
  fullHash: 'full-same',
};

describe('review regressions', () => {
  it('does not catalog zero-byte files as one shared video', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db);
    const empty = (filePath: string, fileId: string): FakeFile => ({
      ...original,
      path: filePath,
      fileId,
      size: 0,
      hash: 'empty',
      fullHash: 'empty',
    });
    const scan = largeDeps({
      directories: ['D:\\dance'],
      files: [empty('D:\\dance\\a.mp4', '1'), empty('D:\\dance\\b.mp4', '2')],
    });
    scan.deps.hashCoversFile = () => true;
    await scanLibrary(db, 'lib', scan.deps, { thumbsDir: tempDir() });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM videos`).get()).toEqual({ count: 0 });
  });

  it('merges a row that was stored with a null hash into an excluded video (B1)', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db);
    const first = largeDeps({ directories: ['D:\\dance'], files: [original] });
    await scanLibrary(db, 'lib', first.deps, { thumbsDir: tempDir() });
    const kept = (db.prepare(`SELECT id FROM videos`).get() as { id: string }).id;
    db.prepare(`UPDATE videos SET title = 'Not dance', excluded = 1 WHERE id = ?`).run(kept);

    const copy: FakeFile = {
      ...original,
      path: 'D:\\dance\\copy.mp4',
      fileId: '9',
    };
    const failed = largeDeps({
      directories: ['D:\\dance'],
      files: [original, copy],
      failHash: new Set([copy.path]),
    });
    failed.thumbs.add(`${kept}.jpg`);
    await scanLibrary(db, 'lib', failed.deps, { thumbsDir: tempDir() });

    const recovered = largeDeps({ directories: ['D:\\dance'], files: [original, copy] });
    recovered.thumbs.add(`${kept}.jpg`);
    const summary = await scanLibrary(db, 'lib', recovered.deps, { thumbsDir: tempDir() });
    expect(summary.errors).toBe(0);
    const videos = db.prepare(`SELECT id, excluded, title FROM videos`).all() as {
      id: string;
      excluded: number;
      title: string;
    }[];
    expect(videos).toEqual([{ id: kept, excluded: 1, title: 'Not dance' }]);
    const paths = db.prepare(`SELECT path FROM video_locations ORDER BY path`).all();
    expect(paths).toEqual([{ path: 'D:\\dance\\copy.mp4' }, { path: 'D:\\dance\\lesson.mp4' }]);
  });

  it('does not write the same full hash onto two rows (B2)', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db);
    const insertVideo = db.prepare(
      `INSERT INTO videos (id, content_hash, size_bytes, created_at, updated_at)
       VALUES (?, 'partial-same', 8000000, ?, ?)`,
    );
    insertVideo.run('video-a', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
    insertVideo.run('video-b', '2024-01-02T00:00:00.000Z', '2024-01-02T00:00:00.000Z');
    const insertLocation = db.prepare(
      `INSERT INTO video_locations (
         id, video_id, library_id, path, filename, size_bytes, mtime_ns, created_at, updated_at
       ) VALUES (?, ?, 'lib', ?, ?, 8000000, '10', 't', 't')`,
    );
    insertLocation.run('loc-a', 'video-a', 'D:\\dance\\a.mp4', 'a.mp4');
    insertLocation.run('loc-b', 'video-b', 'D:\\dance\\b.mp4', 'b.mp4');

    const third: FakeFile = {
      ...original,
      path: 'D:\\dance\\c.mp4',
      fileId: '3',
    };
    const scan = largeDeps({
      directories: ['D:\\dance'],
      files: [
        { ...original, path: 'D:\\dance\\a.mp4', fileId: '11' },
        { ...original, path: 'D:\\dance\\b.mp4', fileId: '12' },
        third,
      ],
    });
    const summary = await scanLibrary(db, 'lib', scan.deps, { thumbsDir: tempDir() });
    expect(summary.errors).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM videos`).get()).toEqual({ count: 1 });
    const paths = db
      .prepare(`SELECT path FROM video_locations WHERE video_id = (SELECT id FROM videos)`)
      .all();
    expect(paths).toHaveLength(3);
  });

  it('relinks and keeps exclusion when a large file moves and the old path is gone (B3)', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db);
    const first = largeDeps({ directories: ['D:\\dance'], files: [original] });
    await scanLibrary(db, 'lib', first.deps, { thumbsDir: tempDir() });
    const id = (db.prepare(`SELECT id FROM videos`).get() as { id: string }).id;
    db.prepare(`UPDATE videos SET title = 'Warmup', excluded = 1 WHERE id = ?`).run(id);

    const moved: FakeFile = {
      ...original,
      path: 'E:\\dance\\lesson.mp4',
      fileId: '44',
      volumeId: 'vol:00ff11aa',
    };
    const second = largeDeps({
      directories: ['E:\\dance'],
      files: [moved],
    });
    second.deps.listMounts = async () => [{ volumeId: 'vol:00ff11aa', root: 'E:\\' }];
    db.prepare(
      `UPDATE libraries SET path = 'E:\\dance', volume_id = 'vol:00ff11aa', volume_rel_path = 'dance' WHERE id = 'lib'`,
    ).run();
    const summary = await scanLibrary(db, 'lib', second.deps, { thumbsDir: tempDir() });
    expect(summary.errors).toBe(0);
    expect(summary.added).toBe(0);
    const videos = db.prepare(`SELECT id, title, excluded FROM videos`).all();
    expect(videos).toEqual([{ id, title: 'Warmup', excluded: 1 }]);
    const locations = db.prepare(`SELECT path, presence FROM video_locations`).all();
    expect(locations).toEqual([{ path: 'E:\\dance\\lesson.mp4', presence: 'present' }]);
  });

  it('does not rewrite a location on an offline library when the same bytes appear elsewhere (S1)', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    db.prepare(
      `INSERT INTO libraries (id, path, label, availability, created_at, updated_at)
       VALUES ('lib', 'D:\\dance', 'dance', 'online', 't', 't'),
              ('usb', 'E:\\clips', 'usb', 'offline', 't', 't')`,
    ).run();
    db.prepare(
      `INSERT INTO videos (id, content_hash, full_hash, size_bytes, created_at, updated_at)
       VALUES ('video', 'partial-same', 'full-same', 8000000, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO video_locations (
         id, video_id, library_id, path, filename, size_bytes, created_at, updated_at
       ) VALUES ('usb-loc', 'video', 'usb', 'E:\\clips\\lesson.mp4', 'lesson.mp4', 8000000, 't', 't')`,
    ).run();
    const copy: FakeFile = { ...original, path: 'D:\\dance\\lesson.mp4' };
    const scan = largeDeps({ directories: ['D:\\dance'], files: [copy] });
    await scanLibrary(db, 'lib', scan.deps, { thumbsDir: tempDir() });
    const usb = db
      .prepare(`SELECT library_id, path FROM video_locations WHERE id = 'usb-loc'`)
      .get();
    expect(usb).toEqual({ library_id: 'usb', path: 'E:\\clips\\lesson.mp4' });
    const added = db
      .prepare(`SELECT library_id, path FROM video_locations WHERE path = 'D:\\dance\\lesson.mp4'`)
      .get();
    expect(added).toEqual({ library_id: 'lib', path: 'D:\\dance\\lesson.mp4' });
  });

  it('does not mark a file missing when its folder could not be listed (S2)', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db);
    db.prepare(
      `INSERT INTO videos (id, content_hash, size_bytes, created_at, updated_at)
       VALUES ('video', 'partial', 10, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO video_locations (
         id, video_id, library_id, path, filename, presence, created_at, updated_at
       ) VALUES ('loc', 'video', 'lib', 'D:\\dance\\sub\\clip.mp4', 'clip.mp4', 'present', 't', 't')`,
    ).run();
    const scan = largeDeps({ directories: ['D:\\dance'], files: [] });
    scan.deps.walkLibrary = async () => ({
      files: [],
      listed: ['D:\\dance'],
      unreadable: ['D:\\dance\\sub'],
    });
    const summary = await scanLibrary(db, 'lib', scan.deps, { thumbsDir: tempDir() });
    expect(summary.missing).toBe(0);
    expect(db.prepare(`SELECT presence FROM video_locations WHERE id = 'loc'`).get()).toEqual({
      presence: 'present',
    });
  });

  it('keeps the path row when a reused file id is renamed onto that path (B4)', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db);
    const lesson: FakeFile = { ...original, hash: 'partial-lesson', fullHash: 'full-lesson' };
    const edit: FakeFile = {
      ...original,
      path: 'D:\\dance\\lesson-edit.mp4',
      fileId: '2',
      hash: 'partial-edit',
      fullHash: 'full-edit',
    };
    const first = largeDeps({ directories: ['D:\\dance'], files: [lesson, edit] });
    await scanLibrary(db, 'lib', first.deps, { thumbsDir: tempDir() });

    const renamed: FakeFile = {
      ...edit,
      path: 'D:\\dance\\lesson.mp4',
    };
    const second = largeDeps({ directories: ['D:\\dance'], files: [renamed] });
    const ids = db.prepare(`SELECT id FROM videos`).all() as { id: string }[];
    for (const row of ids) second.thumbs.add(`${row.id}.jpg`);
    const summary = await scanLibrary(db, 'lib', second.deps, { thumbsDir: tempDir() });
    expect(summary.errors).toBe(0);
    const lessonPath = db
      .prepare(
        `SELECT video_id, presence FROM video_locations WHERE path = 'D:\\dance\\lesson.mp4'`,
      )
      .all() as { video_id: string; presence: string }[];
    expect(lessonPath).toHaveLength(1);
    expect(lessonPath[0]?.presence).toBe('present');
    const missing = db
      .prepare(`SELECT presence FROM video_locations WHERE path = 'D:\\dance\\lesson-edit.mp4'`)
      .get() as { presence: string };
    expect(missing.presence).toBe('missing');
  });
});
