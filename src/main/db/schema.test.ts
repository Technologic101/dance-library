import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepository } from '../indexer/repository';
import { applyMigrations, migrate, migrations } from './migrate';
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
  it('adds Phase 3 built-in styles when upgrading v5 without duplicating a user style', () => {
    const db = openMemory();
    applyMigrations(db, migrations.slice(0, 5));
    db.prepare(
      `INSERT INTO styles(id,name,builtin,created_at) VALUES('user-zouk','Brazilian Zouk',0,'t')`,
    ).run();
    expect(migrate(db)).toEqual(['006_catalog_editing', '007_catalog_editing_fixes']);
    for (const name of [
      'Kizomba Fusion',
      'Salsa On1',
      'Salsa On2',
      'Brazilian Zouk',
      'Zouk Lambada',
    ]) {
      const rows = db.prepare('SELECT id FROM styles WHERE name=? COLLATE NOCASE').all(name);
      expect(rows, name).toHaveLength(1);
    }
  });
  it('upgrades a phase 0 database and keeps the references-only policy', () => {
    const db = openMemory();
    applyMigrations(db, [migration001]);
    expect(migrate(db)).toEqual([
      '002_catalog',
      '003_content_identity',
      '004_path_key',
      '005_search',
      '006_catalog_editing',
      '007_catalog_editing_fixes',
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
      'video_search_keys',
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

    expect(migrate(db)).toEqual([
      '003_content_identity',
      '004_path_key',
      '005_search',
      '006_catalog_editing',
      '007_catalog_editing_fixes',
    ]);
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

  it('backfills search for videos that existed before full-text indexing', () => {
    const db = openMemory();
    applyMigrations(
      db,
      migrations.filter((migration) => migration.id <= 4),
    );
    db.prepare(
      `INSERT INTO libraries (id, path, label, created_at, updated_at) VALUES ('lib', '/dance', 'dance', 't', 't')`,
    ).run();
    db.prepare(
      `INSERT INTO videos (
         id, title, notes, captured_at, captured_at_source, created_at, updated_at
       ) VALUES (
         'vid', 'Kizomba class', 'keep the notes', '2024-06-30T22:00:00', 'filename', 't', 't'
       )`,
    ).run();
    db.prepare(
      `INSERT INTO video_locations (
         id, video_id, library_id, path, filename, presence, created_at, updated_at
       ) VALUES
         ('a', 'vid', 'lib', '/dance/kizomba-demo.mp4', 'kizomba-demo.mp4', 'present', 't', 't'),
         ('b', 'vid', 'lib', '/dance/copy.mp4', 'copy.mp4', 'present', 't', 't')`,
    ).run();
    db.prepare(`INSERT INTO tags (id, name, created_at) VALUES ('tag-wave', 'wave', 't')`).run();
    db.prepare(`INSERT INTO video_tags (video_id, tag_id) VALUES ('vid', 'tag-wave')`).run();

    expect(migrate(db)).toEqual(['005_search', '006_catalog_editing', '007_catalog_editing_fixes']);
    const repo = createRepository(db);
    expect(repo.listVideoSummaries({ text: 'kizomba' }).map((item) => item.id)).toEqual(['vid']);
    expect(repo.listVideoSummaries({ text: 'copy' }).map((item) => item.id)).toEqual(['vid']);
    expect(repo.listVideoSummaries({ text: 'notes' }).map((item) => item.id)).toEqual(['vid']);
    expect(repo.listVideoSummaries({ text: 'wave' }).map((item) => item.id)).toEqual(['vid']);
    const captured = db.prepare(`SELECT captured_at AS capturedAt FROM videos`).get() as {
      capturedAt: string;
    };
    expect(captured.capturedAt.endsWith('Z')).toBe(true);
  });
});
