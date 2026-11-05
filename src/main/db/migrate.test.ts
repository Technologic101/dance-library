import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, migrate, migrations, type Migration } from './migrate';
import { migration001 } from './migrations/001_init';

const openDatabases: Database.Database[] = [];

function openMemory(): Database.Database {
  const db = new Database(':memory:');
  openDatabases.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) db.close();
});

describe('applyMigrations', () => {
  it('applies the initial migration once and records it', () => {
    const db = openMemory();
    expect(applyMigrations(db, [migration001])).toEqual(['001_init']);
    expect(applyMigrations(db, [migration001])).toEqual([]);

    const row = db.prepare('SELECT name, applied_at FROM schema_migrations WHERE id = 1').get() as {
      name: string;
      applied_at: string;
    };
    expect(row.name).toBe('001_init');
    expect(row.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const policy = db.prepare(`SELECT value FROM app_meta WHERE key = 'catalog_policy'`).get() as {
      value: string;
    };
    expect(policy.value).toBe('references-only');

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all();
    expect(tables).toEqual([{ name: 'app_meta' }, { name: 'schema_migrations' }]);
  });

  it('runs migrations in id order without mutating the input list', () => {
    const db = openMemory();
    const first: Migration = {
      id: 1,
      name: '001_table',
      up(database) {
        database.exec('CREATE TABLE ordered (id INTEGER)');
      },
    };
    const second: Migration = {
      id: 2,
      name: '002_row',
      up(database) {
        database.exec('INSERT INTO ordered (id) VALUES (1)');
      },
    };
    const list = [second, first];
    expect(applyMigrations(db, list)).toEqual(['001_table', '002_row']);
    expect(list.map((migration) => migration.id)).toEqual([2, 1]);
  });

  it('rejects duplicate or non-contiguous ids', () => {
    const db = openMemory();
    const first: Migration = { id: 1, name: 'a', up() {} };
    const duplicate: Migration = { id: 1, name: 'b', up() {} };
    const skipped: Migration = { id: 3, name: 'c', up() {} };
    expect(() => applyMigrations(db, [first, duplicate])).toThrow(/unique/);
    expect(() => applyMigrations(db, [first, skipped])).toThrow(/contiguous/);
  });

  it('does not record a migration whose up() throws', () => {
    const db = openMemory();
    applyMigrations(db, [migration001]);
    const bad: Migration = {
      id: 2,
      name: '002_bad',
      up() {
        throw new Error('boom');
      },
    };
    expect(() => applyMigrations(db, [migration001, bad])).toThrow(/boom/);
    const ids = db.prepare('SELECT id FROM schema_migrations').all();
    expect(ids).toEqual([{ id: 1 }]);
  });

  it('refuses a database that has an unknown id, a renamed migration, or a gap', () => {
    const db = openMemory();
    applyMigrations(db, [migration001]);

    db.prepare(`UPDATE schema_migrations SET name = 'renamed' WHERE id = 1`).run();
    expect(() => applyMigrations(db, [migration001])).toThrow(/name mismatch/);

    db.prepare(`UPDATE schema_migrations SET name = '001_init' WHERE id = 1`).run();
    db.prepare(`INSERT INTO schema_migrations (id, name) VALUES (2, '002_ghost')`).run();
    expect(() => applyMigrations(db, [migration001])).toThrow(/unknown migration id 2/);

    db.prepare('DELETE FROM schema_migrations WHERE id = 1').run();
    expect(() => applyMigrations(db, [migration001])).toThrow(/missing id 1/);
  });
});

describe('migrate', () => {
  it('ships a contiguous list and applies it', () => {
    expect(migrations.map((migration) => migration.id)).toEqual([1, 2, 3, 4]);
    expect(migrations[0]?.name).toBe('001_init');
    expect(migrations[1]?.name).toBe('002_catalog');
    expect(migrations[2]?.name).toBe('003_content_identity');
    expect(migrations[3]?.name).toBe('004_path_key');
    const db = openMemory();
    expect(migrate(db)).toEqual([
      '001_init',
      '002_catalog',
      '003_content_identity',
      '004_path_key',
    ]);
    expect(migrate(db)).toEqual([]);
  });
});
