import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogPath, openCatalog, readDatabaseHealth } from './catalog';

const directories: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dance-library-db-'));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of directories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('openCatalog', () => {
  it('creates the database in the requested folder and is safe to reopen', () => {
    const dir = tempDir();
    const dbPath = catalogPath(path.join(dir, 'nested'));
    const db = openCatalog(dbPath);
    const health = readDatabaseHealth(db, dbPath);
    expect(health).toEqual({ ok: true, schemaVersion: 7, path: dbPath });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    db.close();

    const reopened = openCatalog(dbPath);
    expect(readDatabaseHealth(reopened, dbPath).schemaVersion).toBe(7);
    reopened.close();
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('fails the health check when the references-only policy is missing', () => {
    const dir = tempDir();
    const dbPath = catalogPath(dir);
    const db = openCatalog(dbPath);
    db.prepare(`DELETE FROM app_meta WHERE key = 'catalog_policy'`).run();
    expect(readDatabaseHealth(db, dbPath)).toMatchObject({
      ok: false,
      schemaVersion: 7,
      error: 'Catalog policy is not references-only',
    });
    db.close();
  });
});
