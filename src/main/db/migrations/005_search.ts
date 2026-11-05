import type { Migration } from '../migrate';
import { builtinStyleId, builtinStyleNames } from '../../../shared/builtinStyles';
import { normalizeStoredCaptureDates, SEARCH_BACKFILL_SQL } from '../searchIndex';

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

/**
 * Full-text search over titles, notes, tags, and filenames.
 * The FTS rowid is the key from video_search_keys, so trigger updates do not
 * scan the index. This migration does not read or write video files.
 */
export const migration005: Migration = {
  id: 5,
  name: '005_search',
  up(db) {
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
