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
      let changed = 0;
      db.transaction(() => {
        const operations = [
          ['addInstructorIds', 'video_instructors', 'instructor_id', 'INSERT OR IGNORE'],
          ['removeInstructorIds', 'video_instructors', 'instructor_id', 'DELETE'],
          ['addTagIds', 'video_tags', 'tag_id', 'INSERT OR IGNORE'],
          ['removeTagIds', 'video_tags', 'tag_id', 'DELETE'],
        ] as const;
        for (const id of ids) {
          if (!db.prepare('SELECT 1 FROM videos WHERE id=?').get(id)) continue;
          setScalars(id, patch);
          changed++;
          for (const [key, table, column, verb] of operations)
            for (const value of patch[key] ?? []) {
              if (verb === 'DELETE')
                db.prepare(`DELETE FROM ${table} WHERE video_id=? AND ${column}=?`).run(id, value);
              else
                db.prepare(`${verb} INTO ${table} (video_id,${column}) VALUES (?,?)`).run(
                  id,
                  value,
                );
            }
        }
      })();
      return changed;
    },
    searchValues(kind: CatalogValueKind, query: string, limit = 30): CatalogValue[] {
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
        .prepare('SELECT video_type AS type FROM videos WHERE id=?')
        .get(lessonId) as { type: string | null } | undefined;
      const demo = db.prepare('SELECT video_type AS type FROM videos WHERE id=?').get(demoId) as
        { type: string | null } | undefined;
      if (!lesson || !demo) throw new Error('Video not found.');
      if (lesson.type !== 'lesson' || demo.type !== 'demo')
        throw new Error('Links must point from a lesson to a demo.');
      try {
        db.prepare(
          `INSERT INTO video_links (id,video_id,other_video_id,kind,created_at) VALUES (?,?,?,'lesson_demo',?)`,
        ).run(randomUUID(), lessonId, demoId, new Date().toISOString());
      } catch {
        throw new Error('That lesson and demo are already linked.');
      }
    },
    unlinkLessonDemo(lessonId: string, demoId: string): void {
      db.prepare(
        `DELETE FROM video_links WHERE video_id=? AND other_video_id=? AND kind='lesson_demo'`,
      ).run(lessonId, demoId);
    },
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}
