import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  BulkVideoUpdate,
  CatalogValue,
  CatalogValueKind,
  VideoDetails,
  VideoUpdate,
} from '../shared/api';

const tables = { style: 'styles', instructor: 'instructors', tag: 'tags' } as const;

export function createCatalogEditor(db: Database.Database) {
  function details(id: string): VideoDetails {
    const row = db
      .prepare(
        `
      SELECT v.id, v.title, v.video_type AS videoType, v.level, v.event_name AS eventName,
        v.event_date AS eventDate, v.rating, v.favorite, v.notes,
        s.id AS styleId, s.name AS styleName, s.builtin AS styleBuiltin,
        COALESCE(NULLIF(TRIM(v.title), ''), (
          SELECT filename FROM video_locations WHERE video_id=v.id
          ORDER BY CASE presence WHEN 'present' THEN 0 ELSE 1 END, filename COLLATE NOCASE LIMIT 1
        ), 'Untitled') AS displayTitle
      FROM videos v LEFT JOIN styles s ON s.id=v.style_id WHERE v.id=?
    `,
      )
      .get(id) as
      | {
          id: string;
          displayTitle: string;
          title: string | null;
          videoType: VideoDetails['videoType'];
          styleId: string | null;
          styleName: string | null;
          styleBuiltin: number | null;
          level: VideoDetails['level'];
          eventName: string | null;
          eventDate: string | null;
          rating: number | null;
          favorite: number;
          notes: string | null;
        }
      | undefined;
    if (!row) throw new Error('Video not found.');
    const values = (table: 'instructors' | 'tags', join: string, foreign: string) =>
      db
        .prepare(
          `SELECT x.id, x.name FROM ${table} x JOIN ${join} j ON j.${foreign}=x.id
        WHERE j.video_id=? ORDER BY x.name COLLATE NOCASE`,
        )
        .all(id) as CatalogValue[];
    const links = db
      .prepare(
        `
      SELECT other.id, COALESCE(NULLIF(TRIM(other.title), ''),
        (SELECT filename FROM video_locations WHERE video_id=other.id ORDER BY filename COLLATE NOCASE LIMIT 1),
        'Untitled') AS title, other.video_type AS videoType
      FROM video_links l JOIN videos other ON other.id = CASE WHEN l.video_id=? THEN l.other_video_id ELSE l.video_id END
      WHERE l.kind='lesson_demo' AND (l.video_id=? OR l.other_video_id=?) ORDER BY title COLLATE NOCASE
    `,
      )
      .all(id, id, id) as VideoDetails['lessonDemos'];
    return {
      id: row.id,
      displayTitle: row.displayTitle,
      title: row.title,
      videoType: row.videoType,
      style: row.styleId
        ? { id: row.styleId, name: row.styleName ?? '', builtin: Boolean(row.styleBuiltin) }
        : null,
      instructors: values('instructors', 'video_instructors', 'instructor_id'),
      level: row.level,
      eventName: row.eventName,
      eventDate: row.eventDate,
      tags: values('tags', 'video_tags', 'tag_id'),
      rating: row.rating,
      favorite: Boolean(row.favorite),
      notes: row.notes,
      lessonDemos: links,
    };
  }

  function setScalars(id: string, patch: VideoUpdate | BulkVideoUpdate): void {
    const columns: Record<string, string> = {
      title: 'title',
      videoType: 'video_type',
      styleId: 'style_id',
      level: 'level',
      eventName: 'event_name',
      eventDate: 'event_date',
      rating: 'rating',
      favorite: 'favorite',
      notes: 'notes',
    };
    const entries = Object.entries(columns).filter(([key]) =>
      Object.prototype.hasOwnProperty.call(patch, key),
    );
    if (!entries.length) return;
    if (
      Object.prototype.hasOwnProperty.call(patch, 'videoType') &&
      db.prepare('SELECT video_type FROM videos WHERE id=?').pluck().get(id) !== patch.videoType &&
      db
        .prepare(`SELECT 1 FROM video_links WHERE video_id=? OR other_video_id=? LIMIT 1`)
        .get(id, id)
    )
      throw new Error('Unlink lesson/demo videos before changing their type.');
    const params: Record<string, unknown> = { id, now: new Date().toISOString() };
    const set = entries.map(([key, column]) => {
      const value = (patch as unknown as Record<string, unknown>)[key];
      params[key] = key === 'favorite' ? (value ? 1 : 0) : value;
      return `${column}=@${key}`;
    });
    const result = db
      .prepare(`UPDATE videos SET ${set.join(', ')}, updated_at=@now WHERE id=@id`)
      .run(params);
    if (!result.changes) throw new Error('Video not found.');
  }

  function replaceRelations(
    videoId: string,
    table: 'video_instructors' | 'video_tags',
    column: 'instructor_id' | 'tag_id',
    ids: readonly string[],
  ): void {
    db.prepare(`DELETE FROM ${table} WHERE video_id=?`).run(videoId);
    const insert = db.prepare(`INSERT INTO ${table} (video_id, ${column}) VALUES (?, ?)`);
    for (const id of ids) insert.run(videoId, id);
  }

  const exists = db.prepare('SELECT 1 FROM videos WHERE id=?');
  const relationStatements = {
    addInstructorIds: db.prepare(
      'INSERT OR IGNORE INTO video_instructors (video_id,instructor_id) VALUES (?,?)',
    ),
    removeInstructorIds: db.prepare(
      'DELETE FROM video_instructors WHERE video_id=? AND instructor_id=?',
    ),
    addTagIds: db.prepare('INSERT OR IGNORE INTO video_tags (video_id,tag_id) VALUES (?,?)'),
    removeTagIds: db.prepare('DELETE FROM video_tags WHERE video_id=? AND tag_id=?'),
  };
  const touch = db.prepare('UPDATE videos SET updated_at=? WHERE id=?');

  return {
    getVideoDetails: details,
    updateVideo(id: string, patch: VideoUpdate): VideoDetails {
      db.transaction(() => {
        setScalars(id, patch);
        if (patch.instructorIds)
          replaceRelations(id, 'video_instructors', 'instructor_id', patch.instructorIds);
        if (patch.tagIds) replaceRelations(id, 'video_tags', 'tag_id', patch.tagIds);
      })();
      return details(id);
    },
    bulkUpdate(ids: readonly string[], patch: BulkVideoUpdate): number {
      for (const [add, remove] of [
        [patch.addInstructorIds, patch.removeInstructorIds],
        [patch.addTagIds, patch.removeTagIds],
      ] as const)
        if (add?.some((id) => remove?.includes(id)))
          throw new Error('The same value cannot be both added and removed.');
      let changed = 0;
      db.transaction(() => {
        const relationKeys = Object.keys(relationStatements) as (keyof typeof relationStatements)[];
        for (const id of ids) {
          if (!exists.get(id)) continue;
          setScalars(id, patch);
          changed++;
          let relationChanged = false;
          for (const key of relationKeys)
            for (const value of patch[key] ?? [])
              relationChanged =
                relationStatements[key].run(id, value).changes > 0 || relationChanged;
          if (
            relationChanged &&
            !Object.keys(patch).some(
              (key) =>
                key in
                {
                  title: 1,
                  videoType: 1,
                  styleId: 1,
                  level: 1,
                  eventName: 1,
                  eventDate: 1,
                  rating: 1,
                  favorite: 1,
                  notes: 1,
                },
            )
          )
            touch.run(new Date().toISOString(), id);
        }
      })();
      return changed;
    },
    searchValues(kind: CatalogValueKind, query: string, limit = 100): CatalogValue[] {
      const table = tables[kind];
      const term = query.trim();
      return db
        .prepare(
          `SELECT id,name${kind === 'style' ? ', builtin' : ''} FROM ${table}
        WHERE name LIKE ? ESCAPE '\\' COLLATE NOCASE
        ORDER BY CASE WHEN name LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 0 ELSE 1 END, name COLLATE NOCASE LIMIT ?`,
        )
        .all(`%${escapeLike(term)}%`, `${escapeLike(term)}%`, limit) as CatalogValue[];
    },
    createValue(kind: CatalogValueKind, name: string): CatalogValue {
      const table = tables[kind];
      const clean = name.trim();
      if (!clean || clean.length > 120) throw new Error('Name must be 1 to 120 characters.');
      const existing = db
        .prepare(
          `SELECT id,name${kind === 'style' ? ', builtin' : ''} FROM ${table} WHERE name=? COLLATE NOCASE`,
        )
        .get(clean) as CatalogValue | undefined;
      if (existing) return existing;
      const value = { id: randomUUID(), name: clean };
      if (kind === 'style')
        db.prepare('INSERT INTO styles (id,name,builtin,created_at) VALUES (?,?,0,?)').run(
          value.id,
          clean,
          new Date().toISOString(),
        );
      else
        db.prepare(`INSERT INTO ${table} (id,name,created_at) VALUES (?,?,?)`).run(
          value.id,
          clean,
          new Date().toISOString(),
        );
      return { ...value, ...(kind === 'style' ? { builtin: false } : {}) };
    },
    linkLessonDemo(lessonId: string, demoId: string): void {
      if (lessonId === demoId) throw new Error('A video cannot link to itself.');
      const lesson = db
        .prepare('SELECT video_type AS type, excluded FROM videos WHERE id=?')
        .get(lessonId) as { type: string | null; excluded: number } | undefined;
      const demo = db
        .prepare('SELECT video_type AS type, excluded FROM videos WHERE id=?')
        .get(demoId) as { type: string | null; excluded: number } | undefined;
      if (!lesson || !demo) throw new Error('Video not found.');
      if (lesson.excluded || demo.excluded)
        throw new Error('Restore excluded videos before linking them.');
      if (lesson.type !== 'lesson' || demo.type !== 'demo')
        throw new Error('Links must point from a lesson to a demo.');
      try {
        db.prepare(
          `INSERT INTO video_links (id,video_id,other_video_id,kind,created_at) VALUES (?,?,?,'lesson_demo',?)`,
        ).run(randomUUID(), lessonId, demoId, new Date().toISOString());
      } catch (error) {
        if (error instanceof Error && /UNIQUE/.test(error.message))
          throw new Error('That lesson and demo are already linked.');
        throw error;
      }
    },
    unlinkLessonDemo(lessonId: string, demoId: string): void {
      db.prepare(
        `DELETE FROM video_links WHERE kind='lesson_demo'
         AND ((video_id=? AND other_video_id=?) OR (video_id=? AND other_video_id=?))`,
      ).run(lessonId, demoId, demoId, lessonId);
    },
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}
