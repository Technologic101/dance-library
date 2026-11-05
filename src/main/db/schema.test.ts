import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepository } from '../indexer/repository';
import { applyMigrations, migrate } from './migrate';
import { migration001 } from './migrations/001_init';
import { migration002 } from './migrations/002_catalog';

const openDatabases: Database.Database[] = [];

function openMemory(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  openDatabases.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) db.close();
});

describe('catalog schema', () => {
  it('upgrades a phase 0 database and keeps the references-only policy', () => {
    const db = openMemory();
    applyMigrations(db, [migration001]);
    expect(migrate(db)).toEqual([
      '002_catalog',
      '003_content_identity',
      '004_path_key',
      '005_search',
    ]);
    expect(migrate(db)).toEqual([]);

    const policy = db.prepare(`SELECT value FROM app_meta WHERE key = 'catalog_policy'`).get() as {
      value: string;
    };
    expect(policy.value).toBe('references-only');
  });

  it('creates the planned catalog tables and rejects unknown video types', () => {
    const db = openMemory();
    migrate(db);
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string }[];
    expect(tables.map((table) => table.name)).toEqual([
      'app_meta',
      'instructors',
      'libraries',
      'schema_migrations',
      'styles',
      'tags',
      'video_instructors',
      'video_links',
      'video_locations',
      'video_redirects',
      'video_tags',
      'videos',
      'videos_fts',
      'videos_fts_config',
      'videos_fts_content',
      'videos_fts_data',
      'videos_fts_docsize',
      'videos_fts_idx',
    ]);

    db.prepare(
      `INSERT INTO libraries (id, path, label, created_at, updated_at) VALUES ('lib', '/dance', 'dance', 't', 't')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO videos (id, video_type, created_at, updated_at) VALUES ('vid', 'recital', 't', 't')`,
        )
        .run(),
    ).toThrow(/CHECK/i);

    db.prepare(
      `INSERT INTO videos (
         id, video_type, level, rating, favorite, title, notes, created_at, updated_at
       ) VALUES (
         'vid', 'social dance', 'Beginner', 5, 1, 'Warmup', 'keep me', 't', 't'
       )`,
    ).run();
    const video = db
      .prepare(`SELECT title, notes, favorite FROM videos WHERE id = 'vid'`)
      .get() as {
      title: string;
      notes: string;
      favorite: number;
    };
    expect(video).toEqual({ title: 'Warmup', notes: 'keep me', favorite: 1 });
  });

  it('keeps the video when its folder is removed and keeps a migrated title on the content row', () => {
    const db = openMemory();
    applyMigrations(db, [migration001, migration002]);
    db.prepare(
      `INSERT INTO libraries (id, path, label, created_at, updated_at) VALUES ('lib', '/dance', 'dance', 't', 't')`,
    ).run();
    db.prepare(
      `INSERT INTO videos (
         id, library_id, path, filename, title, notes, favorite, created_at, updated_at
       ) VALUES ('vid', 'lib', '/dance/a.mp4', 'a.mp4', 'Warmup', 'keep me', 1, 't', 't')`,
    ).run();

    expect(migrate(db)).toEqual(['003_content_identity', '004_path_key', '005_search']);
    const video = db.prepare(`SELECT title, notes, favorite, excluded FROM videos`).get() as {
      title: string;
      notes: string;
      favorite: number;
      excluded: number;
    };
    const location = db.prepare(`SELECT video_id, path, filename FROM video_locations`).get() as {
      video_id: string;
      path: string;
      filename: string;
    };
    expect(video).toEqual({ title: 'Warmup', notes: 'keep me', favorite: 1, excluded: 0 });
    expect(location).toEqual({ video_id: 'vid', path: '/dance/a.mp4', filename: 'a.mp4' });

    db.prepare(`DELETE FROM libraries WHERE id = 'lib'`).run();
    const videos = db.prepare(`SELECT COUNT(*) AS count FROM videos`).get() as { count: number };
    const locations = db.prepare(`SELECT COUNT(*) AS count FROM video_locations`).get() as {
      count: number;
    };
    expect(videos.count).toBe(1);
    expect(locations.count).toBe(0);
  });

  it('keeps lesson links and the exclusion time when two videos are merged', () => {
    const db = openMemory();
    migrate(db);
    const now = '2024-06-02T00:00:00.000Z';
    db.prepare(
      `INSERT INTO videos (id, title, excluded, excluded_at, created_at, updated_at)
       VALUES ('keep', NULL, 0, NULL, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z'),
              ('drop', 'Tagged', 1, '2024-05-01T00:00:00.000Z', '2024-02-01T00:00:00.000Z', '2024-02-01T00:00:00.000Z'),
              ('other', NULL, 0, NULL, '2024-03-01T00:00:00.000Z', '2024-03-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO video_links (id, video_id, other_video_id, kind, created_at)
       VALUES ('link', 'drop', 'other', 'lesson_demo', 't')`,
    ).run();
    createRepository(db).mergeVideos('keep', ['drop'], now);
    const kept = db
      .prepare(`SELECT title, excluded, excluded_at FROM videos WHERE id = 'keep'`)
      .get();
    const link = db.prepare(`SELECT video_id, other_video_id FROM video_links`).get() as {
      video_id: string;
      other_video_id: string;
    };
    const redirect = db.prepare(`SELECT to_id FROM video_redirects WHERE from_id = 'drop'`).get();
    expect(kept).toEqual({
      title: 'Tagged',
      excluded: 1,
      excluded_at: '2024-05-01T00:00:00.000Z',
    });
    expect(link).toEqual({ video_id: 'keep', other_video_id: 'other' });
    expect(redirect).toEqual({ to_id: 'keep' });
    expect(db.prepare(`SELECT id FROM videos WHERE id = 'drop'`).get()).toBeUndefined();
  });
});
