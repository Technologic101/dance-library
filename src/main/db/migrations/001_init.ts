import type { Migration } from '../migrate';

/**
 * Phase 0 foundation. Video rows arrive in later phases.
 * The catalog stores references and metadata only. This app never moves,
 * modifies, or deletes video files.
 */
export const migration001: Migration = {
  id: 1,
  name: '001_init',
  up(db) {
    db.exec(`
      CREATE TABLE app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      INSERT INTO app_meta (key, value) VALUES ('catalog_policy', 'references-only');
    `);
  },
};
