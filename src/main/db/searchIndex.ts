import type Database from 'better-sqlite3';
import { wallClockToUtc } from '../indexer/captureDate';

/** One statement pair that rebuilds the search index from the catalog tables. */
export const SEARCH_BACKFILL_SQL = `
  INSERT INTO video_search_keys (video_id)
  SELECT id FROM videos;

  INSERT INTO videos_fts (rowid, title, notes, tags, filenames)
  SELECT
    k.rowid,
    COALESCE(v.title, ''),
    COALESCE(v.notes, ''),
    COALESCE((
      SELECT group_concat(t.name, ' ')
      FROM video_tags vt
      JOIN tags t ON t.id = vt.tag_id
      WHERE vt.video_id = v.id
    ), ''),
    COALESCE((
      SELECT group_concat(filename, ' ')
      FROM video_locations
      WHERE video_id = v.id
    ), '')
  FROM video_search_keys k
  JOIN videos v ON v.id = k.video_id;
`;

/**
 * If a trigger was skipped, the full-text table is rebuilt from the catalog.
 * This only writes catalog rows.
 */
export function repairSearchIndex(db: Database.Database): void {
  const videos = db.prepare(`SELECT COUNT(*) AS count FROM videos`).get() as { count: number };
  const indexed = db.prepare(`SELECT COUNT(*) AS count FROM videos_fts`).get() as { count: number };
  if (videos.count === indexed.count) return;
  const rebuild = db.transaction(() => {
    db.exec(`DELETE FROM videos_fts`);
    db.exec(`DELETE FROM video_search_keys`);
    db.exec(SEARCH_BACKFILL_SQL);
  });
  rebuild();
}

/** Filename dates are wall-clock times. Store them as UTC instants like the other sources. */
export function normalizeStoredCaptureDates(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT id, captured_at AS capturedAt FROM videos
       WHERE captured_at IS NOT NULL AND captured_at NOT LIKE '%Z'`,
    )
    .all() as { id: string; capturedAt: string }[];
  const update = db.prepare(`UPDATE videos SET captured_at = ? WHERE id = ?`);
  const apply = db.transaction(() => {
    for (const row of rows) {
      const normalized = wallClockToUtc(row.capturedAt);
      if (normalized !== row.capturedAt) update.run(normalized, row.id);
    }
  });
  apply();
}
