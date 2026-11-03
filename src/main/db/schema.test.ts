import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, migrate } from './migrate';
import { migration001 } from './migrations/001_init';

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
    expect(migrate(db)).toEqual(['002_catalog']);
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
      'video_tags',
      'videos',
    ]);

    db.prepare(
      `INSERT INTO libraries (id, path, label, created_at, updated_at) VALUES ('lib', '/dance', 'dance', 't', 't')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO videos (id, library_id, path, filename, video_type, created_at, updated_at)
           VALUES ('vid', 'lib', '/dance/a.mp4', 'a.mp4', 'recital', 't', 't')`,
        )
        .run(),
    ).toThrow(/CHECK/i);

    db.prepare(
      `INSERT INTO videos (
         id, library_id, path, filename, video_type, level, rating, favorite, title, notes, created_at, updated_at
       ) VALUES (
         'vid', 'lib', '/dance/a.mp4', 'a.mp4', 'social dance', 'Beginner', 5, 1, 'Warmup', 'keep me', 't', 't'
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

  it('deletes catalog rows with the library and leaves no requirement to touch files', () => {
    const db = openMemory();
    migrate(db);
    db.prepare(
      `INSERT INTO libraries (id, path, label, created_at, updated_at) VALUES ('lib', '/dance', 'dance', 't', 't')`,
    ).run();
    db.prepare(
      `INSERT INTO videos (id, library_id, path, filename, created_at, updated_at)
       VALUES ('vid', 'lib', '/dance/a.mp4', 'a.mp4', 't', 't')`,
    ).run();
    db.prepare(`DELETE FROM libraries WHERE id = 'lib'`).run();
    const count = db.prepare(`SELECT COUNT(*) AS count FROM videos`).get() as { count: number };
    expect(count.count).toBe(0);
  });
});
