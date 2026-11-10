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
    TRIM(COALESCE(v.notes, '') || ' ' || COALESCE(v.event_name, '') || ' ' ||
      COALESCE((SELECT s.name FROM styles s WHERE s.id=v.style_id), '') || ' ' ||
      COALESCE((SELECT group_concat(i.name, ' ') FROM video_instructors vi
        JOIN instructors i ON i.id=vi.instructor_id WHERE vi.video_id=v.id), '')),
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

const TAGS_FOR = (videoId: string) => `
  COALESCE((
    SELECT group_concat(t.name, ' ')
    FROM video_tags vt
    JOIN tags t ON t.id = vt.tag_id
    WHERE vt.video_id = ${videoId}
  ), '')
`;

const FILENAMES_FOR = (videoId: string) => `
  COALESCE((
    SELECT group_concat(filename, ' ')
    FROM video_locations
    WHERE video_id = ${videoId}
  ), '')
`;

/** Tables and triggers for search. Indexes on videos stay in the migration. */
export function installSearchSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE video_search_keys (
      rowid INTEGER PRIMARY KEY,
      video_id TEXT NOT NULL UNIQUE
    );

    CREATE VIRTUAL TABLE videos_fts USING fts5(
      title,
      notes,
      tags,
      filenames,
      tokenize = 'unicode61 remove_diacritics 2',
      prefix = '2 3'
    );

    CREATE TRIGGER videos_fts_insert AFTER INSERT ON videos BEGIN
      INSERT INTO video_search_keys (video_id) VALUES (new.id);
      INSERT INTO videos_fts (rowid, title, notes, tags, filenames)
      VALUES (
        (SELECT rowid FROM video_search_keys WHERE video_id = new.id),
        COALESCE(new.title, ''),
        COALESCE(new.notes, ''),
        '',
        ''
      );
    END;

    CREATE TRIGGER videos_fts_update AFTER UPDATE OF title, notes ON videos BEGIN
      UPDATE videos_fts
      SET title = COALESCE(new.title, ''),
          notes = COALESCE(new.notes, '')
      WHERE rowid = (SELECT rowid FROM video_search_keys WHERE video_id = new.id);
    END;

    CREATE TRIGGER videos_fts_delete BEFORE DELETE ON videos BEGIN
      DELETE FROM videos_fts
      WHERE rowid = (SELECT rowid FROM video_search_keys WHERE video_id = old.id);
      DELETE FROM video_search_keys WHERE video_id = old.id;
    END;

    CREATE TRIGGER video_tags_fts_insert AFTER INSERT ON video_tags BEGIN
      UPDATE videos_fts
      SET tags = ${TAGS_FOR('new.video_id')}
      WHERE rowid = (SELECT rowid FROM video_search_keys WHERE video_id = new.video_id);
    END;

    CREATE TRIGGER video_tags_fts_delete AFTER DELETE ON video_tags BEGIN
      UPDATE videos_fts
      SET tags = ${TAGS_FOR('old.video_id')}
      WHERE rowid = (SELECT rowid FROM video_search_keys WHERE video_id = old.video_id);
    END;

    CREATE TRIGGER video_tags_fts_update AFTER UPDATE ON video_tags BEGIN
      UPDATE videos_fts
      SET tags = ${TAGS_FOR('old.video_id')}
      WHERE rowid = (SELECT rowid FROM video_search_keys WHERE video_id = old.video_id);
      UPDATE videos_fts
      SET tags = ${TAGS_FOR('new.video_id')}
      WHERE new.video_id <> old.video_id
        AND rowid = (SELECT rowid FROM video_search_keys WHERE video_id = new.video_id);
    END;

    CREATE TRIGGER tags_fts_rename AFTER UPDATE OF name ON tags
    WHEN old.name IS NOT new.name
    BEGIN
      UPDATE videos_fts
      SET tags = COALESCE((
        SELECT group_concat(t.name, ' ')
        FROM video_tags vt
        JOIN tags t ON t.id = vt.tag_id
        WHERE vt.video_id = (
          SELECT video_id FROM video_search_keys WHERE rowid = videos_fts.rowid
        )
      ), '')
      WHERE rowid IN (
        SELECT k.rowid
        FROM video_search_keys k
        JOIN video_tags vt ON vt.video_id = k.video_id
        WHERE vt.tag_id = new.id
      );
    END;

    CREATE TRIGGER video_locations_fts_insert AFTER INSERT ON video_locations BEGIN
      UPDATE videos_fts
      SET filenames = ${FILENAMES_FOR('new.video_id')}
      WHERE rowid = (SELECT rowid FROM video_search_keys WHERE video_id = new.video_id);
    END;

    CREATE TRIGGER video_locations_fts_delete AFTER DELETE ON video_locations BEGIN
      UPDATE videos_fts
      SET filenames = ${FILENAMES_FOR('old.video_id')}
      WHERE rowid = (SELECT rowid FROM video_search_keys WHERE video_id = old.video_id);
    END;

    CREATE TRIGGER video_locations_fts_update
    AFTER UPDATE OF filename, video_id ON video_locations
    WHEN old.filename IS NOT new.filename OR old.video_id IS NOT new.video_id
    BEGIN
      UPDATE videos_fts
      SET filenames = ${FILENAMES_FOR('new.video_id')}
      WHERE rowid = (SELECT rowid FROM video_search_keys WHERE video_id = new.video_id);
      UPDATE videos_fts
      SET filenames = ${FILENAMES_FOR('old.video_id')}
      WHERE old.video_id <> new.video_id
        AND rowid = (SELECT rowid FROM video_search_keys WHERE video_id = old.video_id);
    END;
  `);
}

function hasTable(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name),
  );
}

function dropSearchObjects(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS videos_fts_insert;
    DROP TRIGGER IF EXISTS videos_fts_update;
    DROP TRIGGER IF EXISTS videos_fts_delete;
    DROP TRIGGER IF EXISTS video_tags_fts_insert;
    DROP TRIGGER IF EXISTS video_tags_fts_delete;
    DROP TRIGGER IF EXISTS video_tags_fts_update;
    DROP TRIGGER IF EXISTS tags_fts_rename;
    DROP TRIGGER IF EXISTS video_locations_fts_insert;
    DROP TRIGGER IF EXISTS video_locations_fts_delete;
    DROP TRIGGER IF EXISTS video_locations_fts_update;
    DROP TRIGGER IF EXISTS video_instructors_fts_insert;
    DROP TRIGGER IF EXISTS video_instructors_fts_delete;
    DROP TRIGGER IF EXISTS instructors_fts_rename;
    DROP TRIGGER IF EXISTS styles_fts_rename;
    DROP TABLE IF EXISTS videos_fts;
    DROP TABLE IF EXISTS video_search_keys;
  `);
}

/**
 * If a trigger was skipped, or a development catalog still has the first
 * Phase 2 search tables, the index is rebuilt from the catalog.
 * This only writes catalog rows.
 */
export function repairSearchIndex(db: Database.Database): void {
  if (!hasTable(db, 'videos')) return;
  if (!hasTable(db, 'video_search_keys')) {
    const rebuildLegacy = db.transaction(() => {
      dropSearchObjects(db);
      installSearchSchema(db);
      installCatalogSearchTriggers(db);
      db.exec(SEARCH_BACKFILL_SQL);
      normalizeStoredCaptureDates(db);
    });
    rebuildLegacy();
    return;
  }
  const videos = db.prepare(`SELECT COUNT(*) AS count FROM videos`).get() as { count: number };
  const indexed = db.prepare(`SELECT COUNT(*) AS count FROM videos_fts`).get() as { count: number };
  const keys = db.prepare(`SELECT COUNT(*) AS count FROM video_search_keys`).get() as {
    count: number;
  };
  if (videos.count === indexed.count && videos.count === keys.count) return;
  const rebuild = db.transaction(() => {
    db.exec(`DELETE FROM videos_fts`);
    db.exec(`DELETE FROM video_search_keys`);
    db.exec(SEARCH_BACKFILL_SQL);
  });
  rebuild();
}

/** Reinstalls Phase 3 triggers after legacy search-schema repair. */
export function installCatalogSearchTriggers(db: Database.Database): void {
  const documentFor = (
    videoId: string,
  ) => `TRIM(COALESCE((SELECT notes FROM videos WHERE id=${videoId}), '') || ' ' ||
    COALESCE((SELECT event_name FROM videos WHERE id=${videoId}), '') || ' ' ||
    COALESCE((SELECT s.name FROM videos v LEFT JOIN styles s ON s.id=v.style_id WHERE v.id=${videoId}), '') || ' ' ||
    COALESCE((SELECT group_concat(i.name,' ') FROM video_instructors vi JOIN instructors i ON i.id=vi.instructor_id WHERE vi.video_id=${videoId}), ''))`;
  db.exec(`
    DROP TRIGGER IF EXISTS videos_fts_update;
    DROP TRIGGER IF EXISTS video_instructors_fts_insert;
    DROP TRIGGER IF EXISTS video_instructors_fts_delete;
    DROP TRIGGER IF EXISTS instructors_fts_rename;
    DROP TRIGGER IF EXISTS styles_fts_rename;
    CREATE TRIGGER videos_fts_update AFTER UPDATE OF title, notes, event_name, style_id ON videos BEGIN
      UPDATE videos_fts SET title=COALESCE(new.title,''), notes=${documentFor('new.id')}
      WHERE rowid=(SELECT rowid FROM video_search_keys WHERE video_id=new.id);
    END;
    CREATE TRIGGER video_instructors_fts_insert AFTER INSERT ON video_instructors BEGIN
      UPDATE videos_fts SET notes=${documentFor('new.video_id')}
      WHERE rowid=(SELECT rowid FROM video_search_keys WHERE video_id=new.video_id);
    END;
    CREATE TRIGGER video_instructors_fts_delete AFTER DELETE ON video_instructors BEGIN
      UPDATE videos_fts SET notes=${documentFor('old.video_id')}
      WHERE rowid=(SELECT rowid FROM video_search_keys WHERE video_id=old.video_id);
    END;
    CREATE TRIGGER instructors_fts_rename AFTER UPDATE OF name ON instructors
    WHEN old.name IS NOT new.name BEGIN
      UPDATE videos_fts SET notes=${documentFor('(SELECT video_id FROM video_search_keys WHERE rowid=videos_fts.rowid)')}
      WHERE rowid IN (SELECT k.rowid FROM video_search_keys k JOIN video_instructors vi ON vi.video_id=k.video_id WHERE vi.instructor_id=new.id);
    END;
    CREATE TRIGGER styles_fts_rename AFTER UPDATE OF name ON styles
    WHEN old.name IS NOT new.name BEGIN
      UPDATE videos_fts SET notes=${documentFor('(SELECT video_id FROM video_search_keys WHERE rowid=videos_fts.rowid)')}
      WHERE rowid IN (SELECT k.rowid FROM video_search_keys k JOIN videos v ON v.id=k.video_id WHERE v.style_id=new.id);
    END;
  `);
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
