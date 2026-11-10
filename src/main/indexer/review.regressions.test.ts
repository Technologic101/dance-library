import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openCatalog } from '../db/catalog';
import { createScanDeps, statIndexedFile } from './fsDeps';
import { pathKey } from './paths';
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

function hasEntries(dir: string, files: { path: string }[], directories: string[]): boolean {
  const slash = dir.includes('\\') ? '\\' : '/';
  const prefix = dir.endsWith('\\') || dir.endsWith('/') ? dir : `${dir}${slash}`;
  return (
    files.some((file) => file.path.startsWith(prefix)) ||
    directories.some((child) => child.startsWith(prefix))
  );
}

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
    sameFilePathAlias: async (left, right) => left === right,
    readDirectory: async () => true,
    directoryHasEntries: async (dir) => hasEntries(dir, input.files, input.directories),
    walkVideos: async function* (root) {
      const prefix = root.endsWith('\\') ? root : `${root}\\`;
      for (const file of input.files) {
        if (file.path.startsWith(prefix)) yield file.path;
      }
    },
    stat: async (filePath) => {
      const listed = await deps.listMounts();
      const named = listed.length > 0;
      if (input.directories.includes(filePath)) {
        return {
          size: 0,
          mtimeNs: '0',
          mtime: new Date('2024-06-01T00:00:00.000Z'),
          birthtime: null,
          fileId: null,
          volumeId: named ? volume : null,
          fileIdStable: true,
        };
      }
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
        volumeId: named ? file.volumeId : null,
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
  it('marks an unreadable root without starting a scan or changing availability', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db);
    const scan = largeDeps({ directories: ['D:\\dance'], files: [] });
    scan.deps.listMounts = async () => [];
    scan.deps.directoryHasEntries = async () => null;

    const summary = await scanLibrary(db, 'lib', scan.deps, { thumbsDir: tempDir() });

    expect(summary).toMatchObject({ errors: 1, offline: 0, discovered: 0 });
    expect(
      db
        .prepare(
          `SELECT availability, scan_generation AS generation, last_error AS lastError FROM libraries`,
        )
        .get(),
    ).toEqual({
      availability: 'online',
      generation: 0,
      lastError: expect.stringMatching(/could not be read/i),
    });
  });

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

  it('marks locations missing when their subfolder is deleted (N1)', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db);
    db.prepare(
      `INSERT INTO videos (id, content_hash, size_bytes, duration_ms, width, height, video_codec, thumbnail_file, created_at, updated_at)
       VALUES ('video', 'partial', 10, 1000, 320, 240, 'h264', 'video.jpg', 't', 't')`,
    ).run();
    db.prepare(
      `INSERT INTO video_locations (
         id, video_id, library_id, path, path_key, filename, presence, created_at, updated_at
       ) VALUES (
         'loc', 'video', 'lib', 'D:\\dance\\2019\\clip.mp4', 'D:/dance/2019/clip.mp4', 'clip.mp4', 'present', 't', 't'
       )`,
    ).run();
    const scan = largeDeps({ directories: ['D:\\dance'], files: [] });
    scan.deps.walkLibrary = async () => ({
      files: [],
      listed: ['D:\\dance'],
      unreadable: [],
    });
    const summary = await scanLibrary(db, 'lib', scan.deps, { thumbsDir: tempDir() });
    expect(summary.missing).toBe(1);
    expect(db.prepare(`SELECT presence FROM video_locations WHERE id = 'loc'`).get()).toEqual({
      presence: 'missing',
    });
  });

  it('stores the full hash on the retry after the first read fails (N2)', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db);
    db.prepare(
      `INSERT INTO videos (
         id, content_hash, full_hash, size_bytes, excluded, title, created_at, updated_at
       ) VALUES (
         'kept', 'partial-same', 'full-same', 8000000, 1, 'Not dance',
         '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z'
       )`,
    ).run();
    const copy: FakeFile = { ...original, path: 'D:\\dance\\copy.mp4', fileId: '9' };
    const failed = largeDeps({ directories: ['D:\\dance'], files: [copy] });
    failed.deps.fullHash = async () => {
      throw new Error('EIO');
    };
    await scanLibrary(db, 'lib', failed.deps, { thumbsDir: tempDir() });
    const afterFailure = db
      .prepare(`SELECT id, full_hash, metadata_error, excluded FROM videos WHERE id != 'kept'`)
      .get() as { id: string; full_hash: string | null; metadata_error: string; excluded: number };
    expect(afterFailure.full_hash).toBeNull();
    expect(afterFailure.metadata_error).toMatch(/EIO/);
    expect(afterFailure.excluded).toBe(0);

    const recovered = largeDeps({ directories: ['D:\\dance'], files: [copy] });
    recovered.thumbs.add(`${afterFailure.id}.jpg`);
    const summary = await scanLibrary(db, 'lib', recovered.deps, { thumbsDir: tempDir() });
    expect(summary.errors).toBe(0);
    const videos = db.prepare(`SELECT id, excluded, full_hash, metadata_error FROM videos`).all();
    expect(videos).toEqual([
      { id: 'kept', excluded: 1, full_hash: 'full-same', metadata_error: null },
    ]);
  });

  it('rewrites a case-only rename instead of adding a missing copy (N4)', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db);
    const renamed: FakeFile = { ...original, path: 'D:\\dance\\Lesson.mp4' };
    const scan = largeDeps({ directories: ['D:\\dance'], files: [renamed] });
    const fold = (filePath: string) => filePath.replaceAll('\\', '/').toLowerCase();
    scan.deps.exists = (filePath) =>
      scan.deps.isDirectory(filePath) ||
      [renamed.path].some((candidate) => fold(candidate) === fold(filePath));
    scan.deps.sameFilePathAlias = async (left, right) => fold(left) === fold(right);
    scan.deps.stat = async (filePath) => {
      if (fold(filePath) !== fold(renamed.path)) {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return {
        size: renamed.size,
        mtimeNs: renamed.mtimeNs,
        mtime: new Date('2024-06-01T00:00:00.000Z'),
        birthtime: null,
        fileId: renamed.fileId,
        volumeId: renamed.volumeId,
        fileIdStable: true,
      };
    };
    db.prepare(
      `INSERT INTO videos (
         id, content_hash, full_hash, size_bytes, duration_ms, width, height, video_codec,
         thumbnail_file, created_at, updated_at
       ) VALUES (
         'video', 'partial-same', 'full-same', 8000000, 1000, 320, 240, 'h264',
         'video.jpg', 't', 't'
       )`,
    ).run();
    db.prepare(
      `INSERT INTO video_locations (
         id, video_id, library_id, path, path_key, filename, volume_id, file_id, size_bytes, mtime_ns,
         presence, created_at, updated_at
       ) VALUES (
         'loc', 'video', 'lib', 'D:\\dance\\lesson.mp4', 'D:/dance/lesson.mp4', 'lesson.mp4',
         ?, '1', 8000000, '10', 'present', 't', 't'
       )`,
    ).run(volume);
    scan.thumbs.add('video.jpg');
    const summary = await scanLibrary(db, 'lib', scan.deps, { thumbsDir: tempDir() });
    expect(summary.errors).toBe(0);
    expect(summary.added).toBe(0);
    expect(summary.linked).toBe(0);
    const locations = db.prepare(`SELECT path, presence FROM video_locations`).all();
    expect(locations).toEqual([{ path: 'D:\\dance\\Lesson.mp4', presence: 'present' }]);
  });

  it('does not mark a present file missing when reading it throws (N3)', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db);
    db.prepare(
      `INSERT INTO videos (id, content_hash, size_bytes, created_at, updated_at)
       VALUES ('video', 'partial', 10, 't', 't')`,
    ).run();
    db.prepare(
      `INSERT INTO video_locations (
         id, video_id, library_id, path, path_key, filename, presence, created_at, updated_at
       ) VALUES (
         'loc', 'video', 'lib', 'D:\\dance\\clip.mp4', 'D:/dance/clip.mp4', 'clip.mp4', 'present', 't', 't'
       )`,
    ).run();
    const scan = largeDeps({
      directories: ['D:\\dance'],
      files: [{ ...original, path: 'D:\\dance\\clip.mp4', size: 10 }],
    });
    scan.deps.stat = async () => {
      const error = new Error('EIO') as NodeJS.ErrnoException;
      error.code = 'EIO';
      throw error;
    };
    const summary = await scanLibrary(db, 'lib', scan.deps, { thumbsDir: tempDir() });
    expect(summary.errors).toBe(1);
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

  it('keeps both locations when two libraries share a hard link (N6)', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    db.prepare(
      `INSERT INTO libraries (id, path, label, created_at, updated_at)
       VALUES ('lib', 'D:\\dance', 'dance', 't', 't'),
              ('backup', 'D:\\dance-backup', 'dance-backup', 't', 't')`,
    ).run();
    const primary: FakeFile = { ...original, path: 'D:\\dance\\clip.mp4', fileId: '77' };
    const link: FakeFile = { ...original, path: 'D:\\dance-backup\\clip.mp4', fileId: '77' };
    const roots = ['D:\\dance', 'D:\\dance-backup'];
    const first = largeDeps({ directories: roots, files: [primary, link] });
    await scanLibrary(db, 'lib', first.deps, { thumbsDir: tempDir() });
    const videoId = (db.prepare(`SELECT id FROM videos`).get() as { id: string }).id;

    const second = largeDeps({ directories: roots, files: [primary, link] });
    second.thumbs.add(`${videoId}.jpg`);
    await scanLibrary(db, 'backup', second.deps, { thumbsDir: tempDir() });
    const third = largeDeps({ directories: roots, files: [primary, link] });
    third.thumbs.add(`${videoId}.jpg`);
    await scanLibrary(db, 'lib', third.deps, { thumbsDir: tempDir() });

    const videos = db.prepare(`SELECT id FROM videos`).all();
    expect(videos).toEqual([{ id: videoId }]);
    const locations = db
      .prepare(`SELECT library_id, path, presence FROM video_locations ORDER BY path`)
      .all();
    expect(locations).toEqual([
      { library_id: 'backup', path: 'D:\\dance-backup\\clip.mp4', presence: 'present' },
      { library_id: 'lib', path: 'D:\\dance\\clip.mp4', presence: 'present' },
    ]);
  });

  it('does not read the bound file again when retrying its full hash', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db);
    const failed = largeDeps({ directories: ['D:\\dance'], files: [original] });
    failed.deps.fullHash = async () => {
      throw new Error('EIO');
    };
    await scanLibrary(db, 'lib', failed.deps, { thumbsDir: tempDir() });
    const id = (db.prepare(`SELECT id FROM videos`).get() as { id: string }).id;

    let reads = 0;
    const recovered = largeDeps({ directories: ['D:\\dance'], files: [original] });
    recovered.thumbs.add(`${id}.jpg`);
    recovered.deps.fullHash = async () => {
      reads += 1;
      return original.fullHash;
    };
    await scanLibrary(db, 'lib', recovered.deps, { thumbsDir: tempDir() });
    expect(reads).toBe(1);
    expect(db.prepare(`SELECT full_hash AS fullHash FROM videos`).get()).toEqual({
      fullHash: 'full-same',
    });
  });

  it('stays offline when the mount listing is empty and the files are gone', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db);
    const first = largeDeps({ directories: ['D:\\dance'], files: [original] });
    await scanLibrary(db, 'lib', first.deps, { thumbsDir: tempDir() });

    const unplugged = largeDeps({ directories: ['D:\\dance'], files: [] });
    unplugged.deps.listMounts = async () => [];
    const summary = await scanLibrary(db, 'lib', unplugged.deps, { thumbsDir: tempDir() });
    expect(summary.offline).toBe(1);
    expect(summary.missing).toBe(0);
    expect(summary.discovered).toBe(0);
    expect(db.prepare(`SELECT availability FROM libraries`).get()).toEqual({
      availability: 'offline',
    });
    expect(db.prepare(`SELECT presence FROM video_locations`).get()).toEqual({
      presence: 'present',
    });
  });

  it('stays online when the mount listing is empty but the files are still there', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db);
    const first = largeDeps({ directories: ['D:\\dance'], files: [original] });
    await scanLibrary(db, 'lib', first.deps, { thumbsDir: tempDir() });
    const id = (db.prepare(`SELECT id FROM videos`).get() as { id: string }).id;

    const stillThere = largeDeps({ directories: ['D:\\dance'], files: [original] });
    stillThere.deps.listMounts = async () => [];
    stillThere.thumbs.add(`${id}.jpg`);
    const summary = await scanLibrary(db, 'lib', stillThere.deps, { thumbsDir: tempDir() });
    expect(summary.offline).toBe(0);
    expect(summary.missing).toBe(0);
    expect(db.prepare(`SELECT availability FROM libraries`).get()).toEqual({
      availability: 'online',
    });
    expect(db.prepare(`SELECT path, presence FROM video_locations`).get()).toEqual({
      path: original.path,
      presence: 'present',
    });
    expect(db.prepare(`SELECT volume_id AS volumeId FROM video_locations`).get()).toEqual({
      volumeId: volume,
    });
  });

  it('stays offline when an empty listing cannot prove the disk and the sampled file moved', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db);
    const first = largeDeps({ directories: ['D:\\dance'], files: [original] });
    await scanLibrary(db, 'lib', first.deps, { thumbsDir: tempDir() });
    const id = (db.prepare(`SELECT id FROM videos`).get() as { id: string }).id;
    db.prepare(`UPDATE videos SET title = 'Warmup' WHERE id = ?`).run(id);

    const moved: FakeFile = { ...original, path: 'D:\\dance\\sorted\\clip.mp4' };
    const second = largeDeps({
      directories: ['D:\\dance', 'D:\\dance\\sorted'],
      files: [moved],
    });
    second.deps.listMounts = async () => [];
    second.thumbs.add(`${id}.jpg`);
    const summary = await scanLibrary(db, 'lib', second.deps, { thumbsDir: tempDir() });
    expect(summary.offline).toBe(1);
    expect(summary.discovered).toBe(0);
    expect(db.prepare(`SELECT availability FROM libraries`).get()).toEqual({
      availability: 'offline',
    });
    expect(db.prepare(`SELECT title FROM videos WHERE id = ?`).get(id)).toEqual({
      title: 'Warmup',
    });
    expect(db.prepare(`SELECT path, presence FROM video_locations`).all()).toEqual([
      { path: original.path, presence: 'present' },
    ]);
  });

  it('relinks a moved file and keeps its volume id when the root volume still matches', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db);
    const first = largeDeps({ directories: ['D:\\dance'], files: [original] });
    await scanLibrary(db, 'lib', first.deps, { thumbsDir: tempDir() });
    const id = (db.prepare(`SELECT id FROM videos`).get() as { id: string }).id;

    const moved: FakeFile = { ...original, path: 'D:\\dance\\sorted\\clip.mp4' };
    const second = largeDeps({
      directories: ['D:\\dance', 'D:\\dance\\sorted'],
      files: [moved],
    });
    second.deps.listMounts = async () => [];
    const stated = second.deps.stat;
    second.deps.stat = async (filePath) => {
      const stat = await stated(filePath);
      if (filePath === 'D:\\dance') return { ...stat, volumeId: volume };
      return stat;
    };
    second.thumbs.add(`${id}.jpg`);
    const summary = await scanLibrary(db, 'lib', second.deps, { thumbsDir: tempDir() });
    expect(summary.offline).toBe(0);
    expect(summary.missing).toBe(0);
    expect(
      db.prepare(`SELECT path, presence, volume_id AS volumeId FROM video_locations`).get(),
    ).toEqual({
      path: moved.path,
      presence: 'present',
      volumeId: volume,
    });
  });

  it('does not rewrite a same-library hard link that is not a case alias', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db);
    const archived: FakeFile = { ...original, path: 'D:\\dance\\Archive\\clip.mp4', fileId: '77' };
    const linked: FakeFile = { ...original, path: 'D:\\dance\\2026\\clip.mp4', fileId: '77' };
    const roots = ['D:\\dance', 'D:\\dance\\Archive', 'D:\\dance\\2026'];
    const first = largeDeps({ directories: roots, files: [archived] });
    await scanLibrary(db, 'lib', first.deps, { thumbsDir: tempDir() });
    const id = (db.prepare(`SELECT id FROM videos`).get() as { id: string }).id;
    const locationId = (db.prepare(`SELECT id FROM video_locations`).get() as { id: string }).id;
    const second = largeDeps({ directories: roots, files: [linked, archived] });
    second.thumbs.add(`${id}.jpg`);
    const summary = await scanLibrary(db, 'lib', second.deps, { thumbsDir: tempDir() });
    expect(summary).toMatchObject({ updated: 0, linked: 1, unchanged: 1, missing: 0 });
    expect(db.prepare(`SELECT path FROM video_locations WHERE id = ?`).get(locationId)).toEqual({
      path: archived.path,
    });
  });

  it('does not rewrite a case-differing hard link on a case-sensitive filesystem', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db);
    const upper: FakeFile = { ...original, path: 'D:\\dance\\Clip.mp4', fileId: '77' };
    const lower: FakeFile = { ...original, path: 'D:\\dance\\clip.mp4', fileId: '77' };
    const first = largeDeps({ directories: ['D:\\dance'], files: [upper] });
    await scanLibrary(db, 'lib', first.deps, { thumbsDir: tempDir() });
    const id = (db.prepare(`SELECT id FROM videos`).get() as { id: string }).id;
    const locationId = (db.prepare(`SELECT id FROM video_locations`).get() as { id: string }).id;
    const second = largeDeps({ directories: ['D:\\dance'], files: [lower, upper] });
    second.thumbs.add(`${id}.jpg`);
    const summary = await scanLibrary(db, 'lib', second.deps, { thumbsDir: tempDir() });
    expect(summary).toMatchObject({ updated: 0, linked: 1, unchanged: 1, missing: 0 });
    expect(db.prepare(`SELECT path FROM video_locations WHERE id = ?`).get(locationId)).toEqual({
      path: upper.path,
    });
  });

  it('still rewrites a rename that differs only by case', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db);
    const renamed: FakeFile = { ...original, path: 'D:\\dance\\Lesson.mp4' };
    const scan = largeDeps({ directories: ['D:\\dance'], files: [renamed] });
    const fold = (filePath: string) => filePath.replaceAll('\\', '/').toLowerCase();
    scan.deps.exists = (filePath) =>
      scan.deps.isDirectory(filePath) ||
      [renamed.path].some((candidate) => fold(candidate) === fold(filePath));
    // Windows takes the pathsEqual fast path; this exercises canonical aliases on POSIX.
    scan.deps.sameFilePathAlias = async (left, right) => fold(left) === fold(right);
    scan.deps.stat = async (filePath) => {
      if (scan.deps.isDirectory(filePath)) {
        return {
          size: 0,
          mtimeNs: '0',
          mtime: new Date('2024-06-01T00:00:00.000Z'),
          birthtime: null,
          fileId: null,
          volumeId: volume,
          fileIdStable: true,
        };
      }
      if (fold(filePath) !== fold(renamed.path)) {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return {
        size: renamed.size,
        mtimeNs: renamed.mtimeNs,
        mtime: new Date('2024-06-01T00:00:00.000Z'),
        birthtime: null,
        fileId: renamed.fileId,
        volumeId: renamed.volumeId,
        fileIdStable: true,
      };
    };
    db.prepare(
      `INSERT INTO videos (
         id, content_hash, full_hash, size_bytes, duration_ms, width, height, video_codec,
         thumbnail_file, created_at, updated_at
       ) VALUES (
         'video', 'partial-same', 'full-same', 8000000, 1000, 320, 240, 'h264',
         'video.jpg', 't', 't'
       )`,
    ).run();
    db.prepare(
      `INSERT INTO video_locations (
         id, video_id, library_id, path, path_key, filename, volume_id, file_id, size_bytes, mtime_ns,
         presence, created_at, updated_at
       ) VALUES (
         'loc', 'video', 'lib', 'D:\\dance\\lesson.mp4', 'D:/dance/lesson.mp4', 'lesson.mp4',
         ?, '1', 8000000, '10', 'present', 't', 't'
       )`,
    ).run(volume);
    scan.thumbs.add('video.jpg');
    await scanLibrary(db, 'lib', scan.deps, { thumbsDir: tempDir() });
    expect(db.prepare(`SELECT id, path FROM video_locations`).all()).toEqual([
      { id: 'loc', path: 'D:\\dance\\Lesson.mp4' },
    ]);
  });

  it('stays offline when every location is already missing and the saved disk is gone', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    db.prepare(
      `INSERT INTO libraries (
         id, path, volume_id, volume_rel_path, label, availability, created_at, updated_at
       ) VALUES ('lib', 'D:\\dance', ?, 'dance', 'dance', 'offline', 't', 't')`,
    ).run(volume);
    db.prepare(`INSERT INTO videos (id, created_at, updated_at) VALUES ('video', 't', 't')`).run();
    db.prepare(
      `INSERT INTO video_locations (
         id, video_id, library_id, path, filename, presence, created_at, updated_at
       ) VALUES ('loc', 'video', 'lib', 'D:\\dance\\gone.mp4', 'gone.mp4', 'missing', 't', 't')`,
    ).run();
    const stranger: FakeFile = { ...original, path: 'D:\\dance\\other.mp4', fileId: '99' };
    const scan = largeDeps({ directories: ['D:\\dance'], files: [stranger] });
    scan.deps.listMounts = async () => [{ volumeId: 'vol:other', root: 'D:\\' }];
    scan.deps.stat = async (filePath) => {
      if (filePath === 'D:\\dance') {
        return {
          size: 0,
          mtimeNs: '0',
          mtime: new Date('2024-06-01T00:00:00.000Z'),
          birthtime: null,
          fileId: null,
          volumeId: 'vol:other',
          fileIdStable: true,
        };
      }
      return {
        size: stranger.size,
        mtimeNs: stranger.mtimeNs,
        mtime: new Date('2024-06-01T00:00:00.000Z'),
        birthtime: null,
        fileId: stranger.fileId,
        volumeId: 'vol:other',
        fileIdStable: true,
      };
    };
    const summary = await scanLibrary(db, 'lib', scan.deps, { thumbsDir: tempDir() });
    expect(summary.offline).toBe(1);
    expect(summary.discovered).toBe(0);
    expect(db.prepare(`SELECT id FROM videos`).all()).toEqual([{ id: 'video' }]);
  });

  it('does not mark the library missing when an empty listing sees a different disk', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db);
    const first = largeDeps({ directories: ['D:\\dance'], files: [original] });
    await scanLibrary(db, 'lib', first.deps, { thumbsDir: tempDir() });
    const stranger: FakeFile = {
      ...original,
      path: 'D:\\dance\\other.mp4',
      fileId: '99',
      hash: 'partial-other',
      fullHash: 'full-other',
    };
    const second = largeDeps({ directories: ['D:\\dance'], files: [stranger] });
    second.deps.listMounts = async () => [];
    second.deps.stat = async (filePath) => {
      if (filePath === 'D:\\dance') {
        return {
          size: 0,
          mtimeNs: '0',
          mtime: new Date('2024-06-01T00:00:00.000Z'),
          birthtime: null,
          fileId: null,
          volumeId: 'vol:other',
          fileIdStable: true,
        };
      }
      return {
        size: stranger.size,
        mtimeNs: stranger.mtimeNs,
        mtime: new Date('2024-06-01T00:00:00.000Z'),
        birthtime: null,
        fileId: stranger.fileId,
        volumeId: 'vol:other',
        fileIdStable: true,
      };
    };
    const summary = await scanLibrary(db, 'lib', second.deps, { thumbsDir: tempDir() });
    expect(summary.offline).toBe(1);
    expect(summary.missing).toBe(0);
    expect(db.prepare(`SELECT presence FROM video_locations`).get()).toEqual({
      presence: 'present',
    });
  });

  it('allows a small library to record a missing file when the root volume matches', async () => {
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    addLibrary(db);
    const first = largeDeps({ directories: ['D:\\dance'], files: [original] });
    await scanLibrary(db, 'lib', first.deps, { thumbsDir: tempDir() });
    const stranger: FakeFile = {
      ...original,
      path: 'D:\\dance\\other.mp4',
      fileId: '99',
      hash: 'partial-other',
      fullHash: 'full-other',
    };
    const second = largeDeps({ directories: ['D:\\dance'], files: [stranger] });
    second.deps.listMounts = async () => [];
    const stated = second.deps.stat;
    second.deps.stat = async (filePath) => {
      const stat = await stated(filePath);
      if (filePath === 'D:\\dance') return { ...stat, volumeId: volume };
      return stat;
    };
    const summary = await scanLibrary(db, 'lib', second.deps, { thumbsDir: tempDir() });
    expect(summary.missing).toBe(1);
    expect(summary.errors).toBe(0);
    expect(
      db.prepare(`SELECT presence FROM video_locations WHERE path = ?`).get(original.path),
    ).toEqual({
      presence: 'missing',
    });
    expect(db.prepare(`SELECT last_error AS lastError FROM libraries`).get()).toEqual({
      lastError: null,
    });
  });

  it('stays online through the real stat when the mount listing is empty and the file is still there', async () => {
    const root = tempDir();
    const clip = path.join(root, 'clip.mp4');
    fs.writeFileSync(clip, 'dance-clip');
    const thumbs = tempDir();
    const deps = createScanDeps(thumbs);
    deps.listMounts = async () => [];
    deps.hash = async () => ({ hash: 'partial-real', kind: 'test' });
    deps.hashCoversFile = () => true;
    deps.fullHash = async () => 'full-real';
    deps.probe = async () => ({
      durationMs: 1000,
      width: 320,
      height: 240,
      videoCodec: 'h264',
      metadataCreatedAt: null,
      error: null,
    });
    deps.writeThumbnail = async () => false;

    const observed = await statIndexedFile(clip, []);
    const savedId = observed.volumeId ?? 'uuid:catalog-disk';
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    db.prepare(
      `INSERT INTO libraries (id, path, volume_id, label, availability, created_at, updated_at)
       VALUES ('lib', ?, ?, 'dance', 'online', 't', 't')`,
    ).run(root, savedId);
    db.prepare(
      `INSERT INTO videos (id, content_hash, full_hash, size_bytes, created_at, updated_at)
       VALUES ('video', 'partial-real', 'full-real', ?, 't', 't')`,
    ).run(observed.size);
    db.prepare(
      `INSERT INTO video_locations (
         id, video_id, library_id, path, path_key, filename, volume_id, file_id, size_bytes,
         presence, created_at, updated_at
       ) VALUES (
         'loc', 'video', 'lib', ?, ?, 'clip.mp4', ?, ?, ?, 'present', 't', 't'
       )`,
    ).run(clip, pathKey(clip), savedId, observed.fileId, observed.size);

    const summary = await scanLibrary(db, 'lib', deps, { thumbsDir: thumbs });
    expect(summary.offline).toBe(0);
    expect(db.prepare(`SELECT availability FROM libraries`).get()).toEqual({
      availability: 'online',
    });
    expect(
      db.prepare(`SELECT path, presence, volume_id AS volumeId FROM video_locations`).get(),
    ).toEqual({
      path: clip,
      presence: 'present',
      volumeId: savedId,
    });
  });

  it('stays offline through the real stat when the mount listing is empty and the file is gone', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'other.mp4'), 'stranger');
    const missing = path.join(root, 'gone.mp4');
    const thumbs = tempDir();
    const deps = createScanDeps(thumbs);
    deps.listMounts = async () => [];
    deps.hash = async () => ({ hash: 'partial-stranger', kind: 'test' });
    deps.probe = async () => ({
      durationMs: 1000,
      width: 320,
      height: 240,
      videoCodec: 'h264',
      metadataCreatedAt: null,
      error: null,
    });
    deps.writeThumbnail = async () => false;

    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    db.prepare(
      `INSERT INTO libraries (id, path, volume_id, label, availability, created_at, updated_at)
       VALUES ('lib', ?, 'uuid:catalog-disk', 'dance', 'online', 't', 't')`,
    ).run(root);
    db.prepare(`INSERT INTO videos (id, created_at, updated_at) VALUES ('video', 't', 't')`).run();
    db.prepare(
      `INSERT INTO video_locations (
         id, video_id, library_id, path, path_key, filename, size_bytes, file_id,
         presence, created_at, updated_at
       ) VALUES (
         'loc', 'video', 'lib', ?, ?, 'gone.mp4', 12, '1', 'present', 't', 't'
       )`,
    ).run(missing, pathKey(missing));

    const summary = await scanLibrary(db, 'lib', deps, { thumbsDir: thumbs });
    expect(summary.offline).toBe(1);
    expect(summary.discovered).toBe(0);
    expect(db.prepare(`SELECT id FROM videos`).all()).toEqual([{ id: 'video' }]);
    expect(db.prepare(`SELECT presence FROM video_locations`).get()).toEqual({
      presence: 'present',
    });
  });
});
