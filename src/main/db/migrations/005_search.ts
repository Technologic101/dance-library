import type { Migration } from '../migrate';
import { builtinStyleId, builtinStyleNames } from '../../../shared/builtinStyles';

/**
 * Full-text search over the title people see, notes, tags, and filenames.
 * The index lives in the catalog. This migration does not read or write video files.
 */
export const migration005: Migration = {
  id: 5,
  name: '005_search',
  up(db) {
    db.exec(`
      CREATE VIRTUAL TABLE videos_fts USING fts5(
        video_id UNINDEXED,
        title,
        notes,
        tags,
        filenames,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER videos_fts_insert AFTER INSERT ON videos BEGIN
        INSERT INTO videos_fts (video_id, title, notes, tags, filenames)
        VALUES (new.id, COALESCE(new.title, ''), COALESCE(new.notes, ''), '', '');
      END;

      CREATE TRIGGER videos_fts_update AFTER UPDATE OF title, notes ON videos BEGIN
        UPDATE videos_fts
        SET title = COALESCE(new.title, ''),
            notes = COALESCE(new.notes, '')
        WHERE video_id = new.id;
      END;

      CREATE TRIGGER videos_fts_delete BEFORE DELETE ON videos BEGIN
        DELETE FROM videos_fts WHERE video_id = old.id;
      END;

      CREATE TRIGGER video_tags_fts_insert AFTER INSERT ON video_tags BEGIN
        UPDATE videos_fts
        SET tags = COALESCE((
          SELECT group_concat(t.name, ' ')
          FROM video_tags vt
          JOIN tags t ON t.id = vt.tag_id
          WHERE vt.video_id = new.video_id
        ), '')
        WHERE video_id = new.video_id;
      END;

      CREATE TRIGGER video_tags_fts_delete AFTER DELETE ON video_tags BEGIN
        UPDATE videos_fts
        SET tags = COALESCE((
          SELECT group_concat(t.name, ' ')
          FROM video_tags vt
          JOIN tags t ON t.id = vt.tag_id
          WHERE vt.video_id = old.video_id
        ), '')
        WHERE video_id = old.video_id;
      END;

      CREATE TRIGGER video_locations_fts_insert AFTER INSERT ON video_locations BEGIN
        UPDATE videos_fts
        SET filenames = COALESCE((
          SELECT group_concat(filename, ' ')
          FROM video_locations
          WHERE video_id = new.video_id
        ), '')
        WHERE video_id = new.video_id;
      END;

      CREATE TRIGGER video_locations_fts_delete AFTER DELETE ON video_locations BEGIN
        UPDATE videos_fts
        SET filenames = COALESCE((
          SELECT group_concat(filename, ' ')
          FROM video_locations
          WHERE video_id = old.video_id
        ), '')
        WHERE video_id = old.video_id;
      END;

      CREATE TRIGGER video_locations_fts_update
      AFTER UPDATE OF filename, video_id ON video_locations
      WHEN old.filename IS NOT new.filename OR old.video_id IS NOT new.video_id
      BEGIN
        UPDATE videos_fts
        SET filenames = COALESCE((
          SELECT group_concat(filename, ' ')
          FROM video_locations
          WHERE video_id = new.video_id
        ), '')
        WHERE video_id = new.video_id;

        UPDATE videos_fts
        SET filenames = COALESCE((
          SELECT group_concat(filename, ' ')
          FROM video_locations
          WHERE video_id = old.video_id
        ), '')
        WHERE old.video_id <> new.video_id AND video_id = old.video_id;
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

    const rows = db.prepare(`SELECT id FROM videos`).all() as { id: string }[];
    const backfill = db.prepare(
      `INSERT INTO videos_fts (video_id, title, notes, tags, filenames)
       SELECT
         v.id,
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
       FROM videos v
       WHERE v.id = ?`,
    );
    const fill = db.transaction(() => {
      for (const row of rows) backfill.run(row.id);
    });
    fill();
  },
};
