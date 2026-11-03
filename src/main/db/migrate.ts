import type Database from 'better-sqlite3';
import { migration001 } from './migrations/001_init';
import { migration002 } from './migrations/002_catalog';

export type Migration = {
  id: number;
  name: string;
  up: (db: Database.Database) => void;
};

export const migrations: Migration[] = [migration001, migration002];

export function applyMigrations(db: Database.Database, pending: readonly Migration[]): string[] {
  const ordered = validateMigrations(pending);
  ensureMigrationsTable(db);

  const existing = db.prepare('SELECT id, name FROM schema_migrations ORDER BY id').all() as {
    id: number;
    name: string;
  }[];

  for (let index = 0; index < existing.length; index += 1) {
    const row = existing[index];
    if (!row || row.id !== index + 1) {
      throw new Error(`schema_migrations is missing id ${index + 1}`);
    }
    const migration = ordered.find((item) => item.id === row.id);
    if (!migration) {
      throw new Error(`Database has unknown migration id ${row.id}`);
    }
    if (migration.name !== row.name) {
      throw new Error(
        `Migration ${row.id} name mismatch: database has ${row.name}, code has ${migration.name}`,
      );
    }
  }

  const appliedIds = new Set(existing.map((row) => row.id));
  const ran: string[] = [];
  for (const migration of ordered) {
    if (appliedIds.has(migration.id)) continue;
    const apply = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)').run(
        migration.id,
        migration.name,
      );
    });
    apply();
    ran.push(migration.name);
  }
  return ran;
}

export function migrate(db: Database.Database): string[] {
  return applyMigrations(db, migrations);
}

function validateMigrations(pending: readonly Migration[]): Migration[] {
  const ids = pending.map((migration) => migration.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Migration ids must be unique');
  }
  const ordered = [...pending].sort((a, b) => a.id - b.id);
  for (let index = 0; index < ordered.length; index += 1) {
    const migration = ordered[index];
    if (!migration || migration.id !== index + 1) {
      throw new Error(`Migration ids must be contiguous starting at 1; missing ${index + 1}`);
    }
  }
  return ordered;
}

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
}
