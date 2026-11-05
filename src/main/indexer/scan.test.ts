import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openCatalog } from '../db/catalog';
import { createScanDeps } from './fsDeps';
import {
  emptyScanSummary,
  scanLibrary,
  type IndexedStat,
  type ProbeFields,
  type ScanDeps,
} from './scan';
import { describeWindowsPath, type Mount } from './volumes';

const directories: string[] = [];
const databases: Database.Database[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dance-library-scan-'));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type FakeFile = {
  path: string;
  size: number;
  mtimeNs: string;
  birthtime?: Date | null;
  mtime?: Date;
  fileId: string;
  volumeId: string;
  hash: string;
};

const probeResult: ProbeFields = {
  durationMs: 1500,
  width: 320,
  height: 240,
  videoCodec: 'h264',
  metadataCreatedAt: '2024-06-01T15:04:05.000Z',
  error: null,
};

function fakeDeps(input: {
  files: FakeFile[];
  directories: string[];
  mounts: Mount[];
  readable?: boolean;
}): { deps: ScanDeps; probes: string[]; thumbs: Set<string> } {
  const probes: string[] = [];
  const thumbs = new Set<string>();
  const fileMap = new Map(input.files.map((file) => [file.path, file]));
  const deps: ScanDeps = {
    listMounts: async () => input.mounts,
    describePath: (filePath, mounts) => describeWindowsPath(filePath, mounts),
    isDirectory: (filePath) => input.directories.includes(filePath),
    exists: (filePath) => input.directories.includes(filePath) || fileMap.has(filePath),
    readDirectory: async () => input.readable !== false,
    directoryHasEntries(dir) {
      const prefix = dir.endsWith('\\') ? dir : `${dir}\\`;
      return (
        input.files.some((file) => file.path.startsWith(prefix)) ||
        input.directories.some((child) => child.startsWith(prefix))
      );
    },
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
        mtime: file.mtime ?? new Date('2024-06-01T15:04:05.000Z'),
        birthtime: file.birthtime ?? null,
        fileId: file.fileId,
        volumeId: file.volumeId,
      };
      return stat;
    },
    hash: async (filePath) => {
      const file = fileMap.get(filePath);
      if (!file) throw new Error('missing');
      return { hash: file.hash, kind: 'test' };
    },
    hashCoversFile: () => true,
    fullHash: async () => {
      throw new Error('full hash was not required');
    },
    probe: async (filePath) => {
      probes.push(filePath);
      return probeResult;
    },
    writeThumbnail: async (_filePath, destPath) => {
      thumbs.add(path.basename(destPath));
      return true;
    },
    thumbnailExists: (fileName) => thumbs.has(fileName),
    now: () => '2024-06-02T00:00:00.000Z',
  };
  return { deps, probes, thumbs };
}

function addLibrary(db: Database.Database, libraryPath: string, id = 'lib'): void {
  db.prepare(
    `INSERT INTO libraries (id, path, label, created_at, updated_at) VALUES (?, ?, 'dance', 't', 't')`,
  ).run(id, libraryPath);
}

function videoRow(db: Database.Database) {
  return db.prepare(`SELECT * FROM videos`).all();
}

describe('scanLibrary', () => {
  const volume = 'vol:a1b2c3d4';
  const mounts: Mount[] = [{ volumeId: volume, root: 'D:\\' }];

  it('catalogs technical metadata and a thumbnail without writing user fields', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db, 'D:\\dance');
    const fake = fakeDeps({
      directories: ['D:\\dance'],
      mounts,
      files: [
        {
          path: 'D:\\dance\\lesson.mp4',
          size: 1200,
          mtimeNs: '10',
          fileId: '7',
          volumeId: volume,
          hash: 'abc',
        },
      ],
    });

    const summary = await scanLibrary(db, 'lib', fake.deps, { thumbsDir: tempDir() });
    expect(summary).toMatchObject({ discovered: 1, added: 1, errors: 0, offline: 0 });
    expect(fake.probes).toEqual(['D:\\dance\\lesson.mp4']);
    const row = db.prepare(`SELECT * FROM videos`).get() as Record<string, unknown>;
    const location = db.prepare(`SELECT * FROM video_locations`).get() as Record<string, unknown>;
    expect(row).toMatchObject({
      size_bytes: 1200,
      duration_ms: 1500,
      width: 320,
      height: 240,
      video_codec: 'h264',
      container: 'mp4',
      captured_at: '2024-06-01T15:04:05.000Z',
      captured_at_source: 'metadata',
      content_hash: 'abc',
      title: null,
      favorite: 0,
      excluded: 0,
    });
    expect(location).toMatchObject({
      video_id: row.id,
      path: 'D:\\dance\\lesson.mp4',
      filename: 'lesson.mp4',
      volume_id: volume,
      file_id: '7',
      presence: 'present',
    });
    expect(row.thumbnail_file).toMatch(/\.jpg$/);
    expect(fake.thumbs.has(String(row.thumbnail_file))).toBe(true);
  });

  it('keeps user metadata when a file is renamed on the same volume', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db, 'D:\\dance');
    const original = {
      path: 'D:\\dance\\lesson.mp4',
      size: 1200,
      mtimeNs: '10',
      fileId: '7',
      volumeId: volume,
      hash: 'abc',
    };
    const first = fakeDeps({ directories: ['D:\\dance'], mounts, files: [original] });
    await scanLibrary(db, 'lib', first.deps, { thumbsDir: tempDir() });
    const id = (db.prepare(`SELECT id FROM videos`).get() as { id: string }).id;
    db.prepare(
      `UPDATE videos
       SET title = 'Warmup', notes = 'keep me', favorite = 1, rating = 5,
           video_type = 'lesson', level = 'Beginner', event_name = 'Congress', event_date = '2024-01-01'
       WHERE id = ?`,
    ).run(id);

    const renamed = fakeDeps({
      directories: ['D:\\dance'],
      mounts,
      files: [{ ...original, path: 'D:\\dance\\warmup.mp4' }],
    });
    renamed.thumbs.add(`${id}.jpg`);
    const second = await scanLibrary(db, 'lib', renamed.deps, { thumbsDir: tempDir() });
    expect(second).toMatchObject({ added: 0, updated: 1, unchanged: 0, missing: 0 });
    expect(renamed.probes).toEqual([]);
    const row = db.prepare(`SELECT * FROM videos`).get() as Record<string, unknown>;
    const location = db.prepare(`SELECT path, filename, presence FROM video_locations`).get() as {
      path: string;
      filename: string;
      presence: string;
    };
    expect(row).toMatchObject({
      id,
      title: 'Warmup',
      notes: 'keep me',
      favorite: 1,
      rating: 5,
      video_type: 'lesson',
      level: 'Beginner',
      event_name: 'Congress',
      event_date: '2024-01-01',
    });
    expect(location).toEqual({
      path: 'D:\\dance\\warmup.mp4',
      filename: 'warmup.mp4',
      presence: 'present',
    });
    expect(videoRow(db)).toHaveLength(1);
  });

  it('relinks a file that moved across volumes when it is the only hash match', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db, 'D:\\dance');
    const first = fakeDeps({
      directories: ['D:\\dance'],
      mounts,
      files: [
        {
          path: 'D:\\dance\\lesson.mp4',
          size: 50,
          mtimeNs: '1',
          fileId: '7',
          volumeId: volume,
          hash: 'same',
        },
      ],
    });
    await scanLibrary(db, 'lib', first.deps, { thumbsDir: tempDir() });
    const id = (db.prepare(`SELECT id FROM videos`).get() as { id: string }).id;
    db.prepare(`UPDATE videos SET title = 'Warmup', notes = 'keep me' WHERE id = ?`).run(id);

    const other = 'vol:00ff11aa';
    const moved = fakeDeps({
      directories: ['E:\\dance'],
      mounts: [{ volumeId: other, root: 'E:\\' }],
      files: [
        {
          path: 'E:\\dance\\lesson.mp4',
          size: 50,
          mtimeNs: '2',
          fileId: '99',
          volumeId: other,
          hash: 'same',
        },
      ],
    });
    db.prepare(
      `UPDATE libraries SET volume_id = ?, volume_rel_path = ?, path = ? WHERE id = 'lib'`,
    ).run(other, 'dance', 'E:\\dance');
    const summary = await scanLibrary(db, 'lib', moved.deps, { thumbsDir: tempDir() });
    expect(summary.added).toBe(0);
    expect(summary.missing).toBe(0);
    const row = db.prepare(`SELECT id, title, notes FROM videos`).get() as {
      id: string;
      title: string;
      notes: string;
    };
    const location = db.prepare(`SELECT path, file_id, presence FROM video_locations`).get() as {
      path: string;
      file_id: string;
      presence: string;
    };
    expect(row).toEqual({ id, title: 'Warmup', notes: 'keep me' });
    expect(location).toEqual({ path: 'E:\\dance\\lesson.mp4', file_id: '99', presence: 'present' });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM videos`).get()).toEqual({ count: 1 });
  });

  it('does not steal metadata when the same content still exists at the old path', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db, 'D:\\dance');
    const original = {
      path: 'D:\\dance\\lesson.mp4',
      size: 50,
      mtimeNs: '1',
      fileId: '7',
      volumeId: volume,
      hash: 'same',
    };
    const first = fakeDeps({ directories: ['D:\\dance'], mounts, files: [original] });
    await scanLibrary(db, 'lib', first.deps, { thumbsDir: tempDir() });
    db.prepare(`UPDATE videos SET title = 'Original'`).run();

    const copied = fakeDeps({
      directories: ['D:\\dance'],
      mounts,
      files: [
        original,
        {
          path: 'D:\\dance\\copy.mp4',
          size: 50,
          mtimeNs: '1',
          fileId: '8',
          volumeId: volume,
          hash: 'same',
        },
      ],
    });
    const summary = await scanLibrary(db, 'lib', copied.deps, { thumbsDir: tempDir() });
    expect(summary.added).toBe(0);
    expect(summary.linked).toBe(1);
    const paths = db.prepare(`SELECT path FROM video_locations ORDER BY path`).all() as {
      path: string;
    }[];
    const title = db.prepare(`SELECT title FROM videos`).get() as { title: string };
    expect(paths).toEqual([{ path: 'D:\\dance\\copy.mp4' }, { path: 'D:\\dance\\lesson.mp4' }]);
    expect(title.title).toBe('Original');
    expect(db.prepare(`SELECT COUNT(*) AS count FROM videos`).get()).toEqual({ count: 1 });
  });

  it('marks a file missing when the folder is online and the file is gone', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db, 'D:\\dance');
    const kept = {
      path: 'D:\\dance\\kept.mp4',
      size: 10,
      mtimeNs: '1',
      fileId: '1',
      volumeId: volume,
      hash: 'kept',
    };
    const gone = {
      path: 'D:\\dance\\gone.mp4',
      size: 10,
      mtimeNs: '1',
      fileId: '2',
      volumeId: volume,
      hash: 'gone',
    };
    const first = fakeDeps({ directories: ['D:\\dance'], mounts, files: [kept, gone] });
    await scanLibrary(db, 'lib', first.deps, { thumbsDir: tempDir() });
    db.prepare(
      `UPDATE videos SET title = 'Gone', notes = 'keep me'
       WHERE id = (SELECT video_id FROM video_locations WHERE path = ?)`,
    ).run(gone.path);

    const second = fakeDeps({ directories: ['D:\\dance'], mounts, files: [kept] });
    for (const name of first.thumbs) second.thumbs.add(name);
    const summary = await scanLibrary(db, 'lib', second.deps, { thumbsDir: tempDir() });
    expect(summary.missing).toBe(1);
    const row = db
      .prepare(
        `SELECT v.title AS title, v.notes AS notes, loc.presence AS presence
         FROM videos v JOIN video_locations loc ON loc.video_id = v.id
         WHERE loc.path = ?`,
      )
      .get(gone.path) as { title: string; notes: string; presence: string };
    expect(row).toEqual({ title: 'Gone', notes: 'keep me', presence: 'missing' });
  });

  it('leaves catalog entries in place when the volume is unplugged', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db, 'D:\\dance');
    const file = {
      path: 'D:\\dance\\lesson.mp4',
      size: 10,
      mtimeNs: '1',
      fileId: '1',
      volumeId: volume,
      hash: 'abc',
    };
    const first = fakeDeps({ directories: ['D:\\dance'], mounts, files: [file] });
    await scanLibrary(db, 'lib', first.deps, { thumbsDir: tempDir() });
    db.prepare(`UPDATE videos SET title = 'Warmup'`).run();

    const offline = fakeDeps({ directories: [], mounts: [], files: [] });
    const summary = await scanLibrary(db, 'lib', offline.deps, { thumbsDir: tempDir() });
    expect(summary).toMatchObject({ offline: 1, missing: 0, discovered: 0 });
    expect(offline.probes).toEqual([]);
    const library = db.prepare(`SELECT availability FROM libraries WHERE id = 'lib'`).get() as {
      availability: string;
    };
    const video = db.prepare(`SELECT title FROM videos`).get() as { title: string };
    const presence = db.prepare(`SELECT presence FROM video_locations`).get() as {
      presence: string;
    };
    expect(library.availability).toBe('offline');
    expect(video.title).toBe('Warmup');
    expect(presence.presence).toBe('present');
  });

  it('follows the library when the same volume comes back on another drive letter', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db, 'D:\\dance');
    const file = {
      path: 'D:\\dance\\lesson.mp4',
      size: 10,
      mtimeNs: '4',
      fileId: '15',
      volumeId: volume,
      hash: 'abc',
    };
    const first = fakeDeps({ directories: ['D:\\dance'], mounts, files: [file] });
    await scanLibrary(db, 'lib', first.deps, { thumbsDir: tempDir() });
    const id = (db.prepare(`SELECT id FROM videos`).get() as { id: string }).id;
    db.prepare(`UPDATE videos SET title = 'Warmup' WHERE id = ?`).run(id);

    const returned = fakeDeps({
      directories: ['E:\\dance'],
      mounts: [{ volumeId: volume, root: 'E:\\' }],
      files: [{ ...file, path: 'E:\\dance\\lesson.mp4' }],
    });
    returned.thumbs.add(`${id}.jpg`);
    const summary = await scanLibrary(db, 'lib', returned.deps, { thumbsDir: tempDir() });
    expect(summary).toMatchObject({ added: 0, updated: 1, missing: 0, offline: 0 });
    expect(returned.probes).toEqual([]);
    const library = db.prepare(`SELECT path, availability FROM libraries`).get() as {
      path: string;
      availability: string;
    };
    const video = db.prepare(`SELECT id, title FROM videos`).get() as { id: string; title: string };
    const location = db.prepare(`SELECT path FROM video_locations`).get() as { path: string };
    expect(library).toEqual({ path: 'E:\\dance', availability: 'online' });
    expect(video).toEqual({ id, title: 'Warmup' });
    expect(location.path).toBe('E:\\dance\\lesson.mp4');
  });

  it('does not mark files missing when the folder cannot be read', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db, 'D:\\dance');
    const file = {
      path: 'D:\\dance\\lesson.mp4',
      size: 10,
      mtimeNs: '1',
      fileId: '1',
      volumeId: volume,
      hash: 'abc',
    };
    const first = fakeDeps({ directories: ['D:\\dance'], mounts, files: [file] });
    await scanLibrary(db, 'lib', first.deps, { thumbsDir: tempDir() });
    const unreadable = fakeDeps({
      directories: ['D:\\dance'],
      mounts,
      files: [],
      readable: false,
    });
    const summary = await scanLibrary(db, 'lib', unreadable.deps, { thumbsDir: tempDir() });
    expect(summary.errors).toBe(1);
    expect(summary.missing).toBe(0);
    const video = db.prepare(`SELECT presence FROM video_locations`).get() as { presence: string };
    const library = db.prepare(`SELECT last_error AS lastError FROM libraries`).get() as {
      lastError: string;
    };
    expect(video.presence).toBe('present');
    expect(library.lastError).toMatch(/could not be read/i);
  });

  it('does not call the probe again when size, time, and thumbnail are unchanged', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db, 'D:\\dance');
    const file = {
      path: 'D:\\dance\\lesson.mp4',
      size: 10,
      mtimeNs: '1',
      fileId: '1',
      volumeId: volume,
      hash: 'abc',
    };
    const first = fakeDeps({ directories: ['D:\\dance'], mounts, files: [file] });
    await scanLibrary(db, 'lib', first.deps, { thumbsDir: tempDir() });
    const id = (db.prepare(`SELECT id FROM videos`).get() as { id: string }).id;
    const second = fakeDeps({ directories: ['D:\\dance'], mounts, files: [file] });
    second.thumbs.add(`${id}.jpg`);
    const summary = await scanLibrary(db, 'lib', second.deps, { thumbsDir: tempDir() });
    expect(summary).toMatchObject({ unchanged: 1, added: 0, updated: 0 });
    expect(second.probes).toEqual([]);
    expect(emptyScanSummary().added).toBe(0);
  });

  it('keeps an excluded video hidden when it and another copy are scanned again', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db, 'D:\\dance');
    const original = {
      path: 'D:\\dance\\lesson.mp4',
      size: 40,
      mtimeNs: '1',
      fileId: '1',
      volumeId: volume,
      hash: 'same',
    };
    const first = fakeDeps({ directories: ['D:\\dance'], mounts, files: [original] });
    await scanLibrary(db, 'lib', first.deps, { thumbsDir: tempDir() });
    const id = (db.prepare(`SELECT id FROM videos`).get() as { id: string }).id;
    db.prepare(`UPDATE videos SET title = 'Not dance', excluded = 1 WHERE id = ?`).run(id);

    const again = fakeDeps({
      directories: ['D:\\dance'],
      mounts,
      files: [
        original,
        {
          path: 'D:\\dance\\copy.mp4',
          size: 40,
          mtimeNs: '1',
          fileId: '2',
          volumeId: volume,
          hash: 'same',
        },
      ],
    });
    again.thumbs.add(`${id}.jpg`);
    const summary = await scanLibrary(db, 'lib', again.deps, { thumbsDir: tempDir() });
    expect(summary.added).toBe(0);
    expect(summary.linked).toBe(1);
    const videos = db.prepare(`SELECT id, title, excluded FROM videos`).all() as {
      id: string;
      title: string;
      excluded: number;
    }[];
    const paths = db.prepare(`SELECT path FROM video_locations ORDER BY path`).all();
    expect(videos).toEqual([{ id, title: 'Not dance', excluded: 1 }]);
    expect(paths).toEqual([{ path: 'D:\\dance\\copy.mp4' }, { path: 'D:\\dance\\lesson.mp4' }]);
  });

  it('confirms a large-file duplicate with a full hash and rejects a partial collision', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db, 'D:\\dance');
    const original = {
      path: 'D:\\dance\\lesson.mp4',
      size: 9_000_000,
      mtimeNs: '1',
      fileId: '1',
      volumeId: volume,
      hash: 'partial',
    };
    const first = fakeDeps({ directories: ['D:\\dance'], mounts, files: [original] });
    first.deps.hashCoversFile = () => false;
    const fullHashes = new Map<string, string>([
      [original.path, 'full-a'],
      ['D:\\dance\\same.mp4', 'full-a'],
      ['D:\\dance\\different.mp4', 'full-b'],
    ]);
    const calls: string[] = [];
    first.deps.fullHash = async (filePath) => {
      calls.push(filePath);
      return fullHashes.get(filePath) ?? 'missing';
    };
    await scanLibrary(db, 'lib', first.deps, { thumbsDir: tempDir() });
    expect(calls).toEqual([original.path]);

    const same = fakeDeps({
      directories: ['D:\\dance'],
      mounts,
      files: [original, { ...original, path: 'D:\\dance\\same.mp4', fileId: '2' }],
    });
    same.deps.hashCoversFile = () => false;
    same.deps.fullHash = async (filePath) => {
      calls.push(filePath);
      return fullHashes.get(filePath) ?? 'missing';
    };
    const id = (db.prepare(`SELECT id FROM videos`).get() as { id: string }).id;
    same.thumbs.add(`${id}.jpg`);
    calls.length = 0;
    const linked = await scanLibrary(db, 'lib', same.deps, { thumbsDir: tempDir() });
    expect(linked.added).toBe(0);
    expect(linked.linked).toBe(1);
    expect(calls).toEqual(['D:\\dance\\same.mp4']);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM videos`).get()).toEqual({ count: 1 });
    expect(db.prepare(`SELECT full_hash FROM videos`).get()).toEqual({ full_hash: 'full-a' });

    const collision = fakeDeps({
      directories: ['D:\\dance'],
      mounts,
      files: [
        original,
        { ...original, path: 'D:\\dance\\same.mp4', fileId: '2' },
        { ...original, path: 'D:\\dance\\different.mp4', fileId: '3' },
      ],
    });
    collision.deps.hashCoversFile = () => false;
    collision.deps.fullHash = async (filePath) => fullHashes.get(filePath) ?? 'missing';
    collision.thumbs.add(`${id}.jpg`);
    const split = await scanLibrary(db, 'lib', collision.deps, { thumbsDir: tempDir() });
    expect(split.added).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM videos`).get()).toEqual({ count: 2 });
    const titles = db.prepare(`SELECT title FROM videos WHERE id = ?`).get(id) as { title: null };
    expect(titles.title).toBeNull();
  });
});

describe('scanLibrary on disk', () => {
  it('rescans a few thousand unchanged files without probing them again', async () => {
    const root = tempDir();
    const thumbs = tempDir();
    const count = 2000;
    for (let index = 0; index < count; index += 1) {
      fs.writeFileSync(path.join(root, `clip-${index}.mp4`), `video-${index}`);
    }
    const before = fs.readdirSync(root).map((name) => {
      const stat = fs.statSync(path.join(root, name));
      return { name, size: stat.size, mtimeMs: stat.mtimeMs };
    });

    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db, root, 'bulk');
    let probes = 0;
    const deps = createScanDeps(thumbs);
    deps.probe = async () => {
      probes += 1;
      return probeResult;
    };
    deps.writeThumbnail = async (_file, dest) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, 'thumb');
      return true;
    };

    const first = await scanLibrary(db, 'bulk', deps, { thumbsDir: thumbs });
    expect(first.added).toBe(count);
    expect(probes).toBe(count);

    const started = Date.now();
    const second = await scanLibrary(db, 'bulk', deps, { thumbsDir: thumbs });
    const elapsed = Date.now() - started;
    expect(second).toMatchObject({ added: 0, unchanged: count, missing: 0, errors: 0 });
    expect(probes).toBe(count);
    expect(elapsed).toBeLessThan(15_000);

    const after = fs.readdirSync(root).map((name) => {
      const stat = fs.statSync(path.join(root, name));
      return { name, size: stat.size, mtimeMs: stat.mtimeMs };
    });
    expect(after).toEqual(before);
  }, 30_000);
});
