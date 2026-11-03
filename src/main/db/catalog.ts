import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { DatabaseHealth } from '../../shared/api';
import { migrate } from './migrate';

export const CATALOG_FILENAME = 'catalog.sqlite';
export const CATALOG_POLICY_KEY = 'catalog_policy';
export const CATALOG_POLICY_VALUE = 'references-only';

/**
 * Opens the catalog. The database stores references and metadata only.
 * Nothing in this module moves, modifies, or deletes video files.
 */
export function openCatalog(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function catalogPath(userDataDir: string): string {
  return path.join(userDataDir, CATALOG_FILENAME);
}

export function readDatabaseHealth(db: Database.Database, dbPath: string): DatabaseHealth {
  const versionRow = db.prepare('SELECT MAX(id) AS version FROM schema_migrations').get() as
    { version: number | null } | undefined;
  const schemaVersion = versionRow?.version ?? 0;
  const policyRow = db
    .prepare('SELECT value FROM app_meta WHERE key = ?')
    .get(CATALOG_POLICY_KEY) as { value: string } | undefined;
  if (policyRow?.value !== CATALOG_POLICY_VALUE) {
    return {
      ok: false,
      schemaVersion,
      path: dbPath,
      error: 'Catalog policy is not references-only',
    };
  }
  return { ok: true, schemaVersion, path: dbPath };
}
