import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openCatalog } from './db/catalog';
import { createLibraryService } from './libraryService';
import type { ScanDeps } from './indexer/scan';

const directories: string[] = [];
const databases: Database.Database[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dance-library-lib-'));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function idleDeps(): ScanDeps {
  return {
    listMounts: async () => [],
    describePath: () => null,
    isDirectory: (filePath) => {
      try {
        return fs.statSync(filePath).isDirectory();
      } catch {
        return false;
      }
    },
    exists: (filePath) => fs.existsSync(filePath),
    readDirectory: async () => true,
    walkVideos: async function* () {},
    stat: async () => {
      throw new Error('no files');
    },
    hash: async () => ({ hash: 'x', kind: 'test' }),
    probe: async () => ({
      durationMs: null,
      width: null,
      height: null,
      videoCodec: null,
      metadataCreatedAt: null,
      error: null,
    }),
    writeThumbnail: async () => false,
    thumbnailExists: () => false,
    now: () => '2024-06-02T00:00:00.000Z',
  };
}

describe('createLibraryService', () => {
  it('rejects a missing folder, a duplicate, and a nested folder', async () => {
    const root = tempDir();
    const child = path.join(root, 'lessons');
    fs.mkdirSync(child);
    const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
    databases.push(db);
    const service = createLibraryService(db, tempDir(), idleDeps());

    const missing = await service.addPaths([path.join(root, 'nope')]);
    expect(missing.added).toEqual([]);
    expect(missing.skipped[0]?.message).toMatch(/does not exist/);

    const added = await service.addPaths([root]);
    expect(added.added).toHaveLength(1);
    expect(added.scan?.libraries).toBe(1);

    const duplicate = await service.addPaths([root, child]);
    expect(duplicate.added).toEqual([]);
    expect(duplicate.skipped.map((item) => item.message).join(' ')).toMatch(
      /already in the library/,
    );
    expect(duplicate.skipped.map((item) => item.message).join(' ')).toMatch(/inside a folder/);
  });

  it('removes catalog rows and thumbnails and leaves the source folder alone', async () => {
    const root = tempDir();
    const source = path.join(root, 'videos');
    const video = path.join(source, 'clip.mp4');
    fs.mkdirSync(source);
    fs.writeFileSync(video, 'video-bytes');
    const thumbs = tempDir();
    const db = openCatalog(path.join(root, 'catalog.sqlite'));
    databases.push(db);
    const service = createLibraryService(db, thumbs, idleDeps());
    const added = await service.addPaths([source]);
    const libraryId = added.added[0]?.id;
    if (!libraryId) throw new Error('library was not added');
    const thumb = path.join(thumbs, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg');
    fs.writeFileSync(thumb, 'jpeg');
    db.prepare(`UPDATE videos SET thumbnail_file = ? WHERE library_id = ?`).run(
      path.basename(thumb),
      libraryId,
    );
    db.prepare(
      `INSERT INTO videos (id, library_id, path, filename, thumbnail_file, created_at, updated_at)
       VALUES ('vid', ?, ?, 'clip.mp4', ?, 't', 't')`,
    ).run(libraryId, video, path.basename(thumb));

    expect(await service.removeLibrary(libraryId)).toBe(true);
    expect(service.listLibraries()).toEqual([]);
    expect(service.listVideos()).toEqual([]);
    expect(fs.existsSync(thumb)).toBe(false);
    expect(fs.readFileSync(video, 'utf8')).toBe('video-bytes');
    expect(await service.removeLibrary(libraryId)).toBe(false);
  });
});
