import type { Migration } from '../migrate';
import { builtinStyleId } from '../../../shared/builtinStyles';

const addedStyles = ['Kizomba Fusion', 'Salsa On1', 'Salsa On2', 'Brazilian Zouk', 'Zouk Lambada'];

/** Upgrade-safe Phase 3 corrections. Migration 005 remains an immutable Phase 2 snapshot. */
export const migration007: Migration = {
  id: 7,
  name: '007_catalog_editing_fixes',
  up(db) {
    const existing = db.prepare('SELECT id FROM styles WHERE name=? COLLATE NOCASE');
    const insert = db.prepare(
      `INSERT INTO styles(id,name,builtin,created_at) VALUES(?,?,1,'2024-01-01T00:00:00.000Z')`,
    );
    for (const name of addedStyles) if (!existing.get(name)) insert.run(builtinStyleId(name), name);
    db.exec(`
      DROP TRIGGER IF EXISTS instructors_fts_rename;
      CREATE TRIGGER instructors_fts_rename AFTER UPDATE OF name ON instructors
      WHEN old.name IS NOT new.name BEGIN
        UPDATE videos_fts SET notes=TRIM(COALESCE((SELECT notes FROM videos WHERE id=(SELECT video_id FROM video_search_keys WHERE rowid=videos_fts.rowid)), '') || ' ' ||
          COALESCE((SELECT event_name FROM videos WHERE id=(SELECT video_id FROM video_search_keys WHERE rowid=videos_fts.rowid)), '') || ' ' ||
          COALESCE((SELECT s.name FROM videos v LEFT JOIN styles s ON s.id=v.style_id WHERE v.id=(SELECT video_id FROM video_search_keys WHERE rowid=videos_fts.rowid)), '') || ' ' ||
          COALESCE((SELECT group_concat(i.name,' ') FROM video_instructors vi JOIN instructors i ON i.id=vi.instructor_id WHERE vi.video_id=(SELECT video_id FROM video_search_keys WHERE rowid=videos_fts.rowid)), ''))
        WHERE rowid IN (SELECT k.rowid FROM video_search_keys k JOIN video_instructors vi ON vi.video_id=k.video_id WHERE vi.instructor_id=new.id);
      END;
      DROP TRIGGER IF EXISTS styles_fts_rename;
      CREATE TRIGGER styles_fts_rename AFTER UPDATE OF name ON styles
      WHEN old.name IS NOT new.name BEGIN
        UPDATE videos_fts SET notes=TRIM(COALESCE((SELECT notes FROM videos WHERE id=(SELECT video_id FROM video_search_keys WHERE rowid=videos_fts.rowid)), '') || ' ' ||
          COALESCE((SELECT event_name FROM videos WHERE id=(SELECT video_id FROM video_search_keys WHERE rowid=videos_fts.rowid)), '') || ' ' ||
          COALESCE((SELECT s.name FROM videos v LEFT JOIN styles s ON s.id=v.style_id WHERE v.id=(SELECT video_id FROM video_search_keys WHERE rowid=videos_fts.rowid)), '') || ' ' ||
          COALESCE((SELECT group_concat(i.name,' ') FROM video_instructors vi JOIN instructors i ON i.id=vi.instructor_id WHERE vi.video_id=(SELECT video_id FROM video_search_keys WHERE rowid=videos_fts.rowid)), ''))
        WHERE rowid IN (SELECT k.rowid FROM video_search_keys k JOIN videos v ON v.id=k.video_id WHERE v.style_id=new.id);
      END;
    `);
  },
};
