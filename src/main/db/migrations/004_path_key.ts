import type { Migration } from '../migrate';
import { pathKey } from '../../indexer/paths';

/**
 * Case-folded path lookup, and a redirect when two content rows are merged
 * so a later exclude or restore of the dropped id still lands on the survivor.
 */
export const migration004: Migration = {
  id: 4,
  name: '004_path_key',
  up(db) {
    db.exec(`
      ALTER TABLE video_locations ADD COLUMN path_key TEXT;
      CREATE TABLE video_redirects (
        from_id TEXT PRIMARY KEY,
        to_id TEXT NOT NULL
      );
    `);
    const rows = db.prepare(`SELECT id, path FROM video_locations`).all() as {
      id: string;
      path: string;
    }[];
    const assign = db.prepare(`UPDATE video_locations SET path_key = ? WHERE id = ?`);
    const fill = db.transaction(() => {
      for (const row of rows) assign.run(pathKey(row.path), row.id);
    });
    fill();
    db.exec(`CREATE UNIQUE INDEX video_locations_path_key ON video_locations (path_key);`);
  },
};
