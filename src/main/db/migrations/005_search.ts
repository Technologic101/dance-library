import type { Migration } from '../migrate';
import { builtinStyleId } from '../../../shared/builtinStyles';
import { installSearchSchema, normalizeStoredCaptureDates } from '../searchIndex';

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
      for (const name of phase2BuiltinStyleNames) insertStyle.run(builtinStyleId(name), name);
    });
    seedStyles();
    db.exec(PHASE2_SEARCH_BACKFILL_SQL);
    normalizeStoredCaptureDates(db);
  },
};

// Immutable snapshot: migration 005 shipped with Phase 2 and must remain reproducible.
const phase2BuiltinStyleNames = [
  'Afrobeat',
  'Argentine Tango',
  'Bachata',
  'Bachata Sensual',
  'Ballet',
  'Balboa',
  'Blues',
  'Bolero',
  'Bossa Nova',
  'Breaking',
  'Cha-cha',
  'Charleston',
  'Collegiate Shag',
  'Commercial',
  'Contemporary',
  'Cumbia',
  'East Coast Swing',
  'Foxtrot',
  'Forró',
  'Fusion',
  'Gafieira',
  'Heels',
  'Hip Hop',
  'House',
  'Jazz',
  'Kizomba',
  'Kuduro',
  'Lambada',
  'Lindy Hop',
  'Locking',
  'Mambo',
  'Merengue',
  'Modern',
  'Passada',
  'Popping',
  'Quickstep',
  'Reggaeton',
  'Rumba',
  'Salsa',
  'Samba',
  'Samba Rock',
  'Semba',
  'Soltinho',
  'Tarraxinha',
  'Tango',
  'Urban Kiz',
  'Viennese Waltz',
  'Vogue',
  'Waacking',
  'Waltz',
  'West Coast Swing',
  'Zouk',
] as const;

const PHASE2_SEARCH_BACKFILL_SQL = `
  INSERT INTO video_search_keys (video_id) SELECT id FROM videos;
  INSERT INTO videos_fts (rowid, title, notes, tags, filenames)
  SELECT k.rowid, COALESCE(v.title, ''), COALESCE(v.notes, ''),
    COALESCE((SELECT group_concat(t.name, ' ') FROM video_tags vt JOIN tags t ON t.id=vt.tag_id WHERE vt.video_id=v.id), ''),
    COALESCE((SELECT group_concat(filename, ' ') FROM video_locations WHERE video_id=v.id), '')
  FROM video_search_keys k JOIN videos v ON v.id=k.video_id;
`;
