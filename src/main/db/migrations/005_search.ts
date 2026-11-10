import type { Migration } from '../migrate';
import { builtinStyleId, builtinStyleNames } from '../../../shared/builtinStyles';
import {
  installSearchSchema,
  normalizeStoredCaptureDates,
  SEARCH_BACKFILL_SQL,
} from '../searchIndex';

/**
 * Full-text search over titles, notes, tags, and filenames.
 * The FTS rowid is the key from video_search_keys, so trigger updates do not
 * scan the index. This migration does not read or write video files.
 */
export const migration005: Migration = {
  id: 5,
  name: '005_search',
  up(db) {
    installSearchSchema(db);
    db.exec(`
      CREATE INDEX videos_captured ON videos (captured_at);
      CREATE INDEX videos_type ON videos (video_type);
      CREATE INDEX videos_style ON videos (style_id);
      CREATE INDEX videos_level ON videos (level);
      CREATE INDEX videos_favorite ON videos (favorite);
      CREATE INDEX videos_duration ON videos (duration_ms);
    `);

    const insertStyle = db.prepare(
      `INSERT INTO styles (id, name, builtin, created_at) VALUES (?, ?, 1, '2024-01-01T00:00:00.000Z')`,
    );
    const seedStyles = db.transaction(() => {
      for (const name of builtinStyleNames) insertStyle.run(builtinStyleId(name), name);
    });
    seedStyles();
    db.exec(SEARCH_BACKFILL_SQL);
    normalizeStoredCaptureDates(db);
  },
};
