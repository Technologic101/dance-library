import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  BulkVideoUpdate,
  CatalogValue,
  CatalogValueKind,
  VideoDetails,
  VideoUpdate,
} from '../shared/api';
import { currentMergeSequence, relationMergedSince } from './mergeSequence';

const tables = { style: 'styles', instructor: 'instructors', tag: 'tags' } as const;
const scalarColumns = {
  title: 'title',
  videoType: 'video_type',
  styleId: 'style_id',
  level: 'level',
  eventName: 'event_name',
  eventDate: 'event_date',
  rating: 'rating',
  favorite: 'favorite',
  notes: 'notes',
} as const;
type ScalarKey = keyof typeof scalarColumns;
type UndoSnapshot = {
  id: string;
  mergeSequence: number;
  scalars: Partial<Record<ScalarKey, { before: unknown; after: unknown }>>;
  instructorDelta?: RelationDelta;
  tagDelta?: RelationDelta;
};
type RelationDelta = { added: string[]; removed: string[] };
type CreatedValue = { kind: CatalogValueKind; id: string };
type UndoBatch = {
  token: string;
  snapshots: UndoSnapshot[];
  createdValues: CreatedValue[];
  description: string;
};

export function createCatalogEditor(db: Database.Database, undoLimit = 20) {
  const undoStack: UndoBatch[] = [];
  const pendingCreatedValues = new Map<string, CreatedValue>();
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
    const entries = Object.entries(scalarColumns).filter(([key]) =>
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

  function snapshot(id: string, patch: VideoUpdate | BulkVideoUpdate) {
    const keys = (Object.keys(scalarColumns) as ScalarKey[]).filter((key) =>
      Object.prototype.hasOwnProperty.call(patch, key),
    );
    const scalars: Partial<Record<ScalarKey, unknown>> = {};
    if (keys.length) {
      const columns = keys.map((key) => `${scalarColumns[key]} AS ${key}`).join(', ');
      const row = db.prepare(`SELECT ${columns} FROM videos WHERE id=?`).get(id) as Record<
        ScalarKey,
        unknown
      >;
      for (const key of keys) scalars[key] = key === 'favorite' ? Boolean(row[key]) : row[key];
    }
    const relationIds = (table: 'video_instructors' | 'video_tags', column: string) =>
      (
        db.prepare(`SELECT ${column} AS id FROM ${table} WHERE video_id=?`).all(id) as {
          id: string;
        }[]
      ).map((row) => row.id);
    const instructorsTouched =
      'instructorIds' in patch || 'addInstructorIds' in patch || 'removeInstructorIds' in patch;
    const tagsTouched = 'tagIds' in patch || 'addTagIds' in patch || 'removeTagIds' in patch;
    return {
      id,
      scalars,
      ...(instructorsTouched
        ? { instructorIds: relationIds('video_instructors', 'instructor_id') }
        : {}),
      ...(tagsTouched ? { tagIds: relationIds('video_tags', 'tag_id') } : {}),
    };
  }

  function undoSnapshot(
    before: ReturnType<typeof snapshot>,
    after: ReturnType<typeof snapshot>,
  ): UndoSnapshot | null {
    const scalars: UndoSnapshot['scalars'] = {};
    for (const key of Object.keys(before.scalars) as ScalarKey[])
      if (!Object.is(before.scalars[key], after.scalars[key]))
        scalars[key] = { before: before.scalars[key], after: after.scalars[key] };
    const delta = (oldIds?: string[], newIds?: string[]): RelationDelta | undefined => {
      if (!oldIds || !newIds) return undefined;
      const old = new Set(oldIds),
        next = new Set(newIds);
      const change = {
        added: newIds.filter((id) => !old.has(id)),
        removed: oldIds.filter((id) => !next.has(id)),
      };
      return change.added.length || change.removed.length ? change : undefined;
    };
    const instructorDelta = delta(before.instructorIds, after.instructorIds);
    const tagDelta = delta(before.tagIds, after.tagIds);
    if (!Object.keys(scalars).length && !instructorDelta && !tagDelta) return null;
    return {
      id: before.id,
      mergeSequence: currentMergeSequence(db, before.id),
      scalars,
      instructorDelta,
      tagDelta,
    };
  }

  function remember(
    snapshots: UndoSnapshot[],
    patch: VideoUpdate | BulkVideoUpdate,
  ): string | null {
    if (!snapshots.length) {
      pendingCreatedValues.clear();
      return null;
    }
    const referenced = new Set<string>();
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'styleId' && typeof value === 'string') referenced.add(value);
      if (key.endsWith('Ids') && Array.isArray(value)) for (const id of value) referenced.add(id);
    }
    const createdValues = [...pendingCreatedValues.values()].filter((value) =>
      referenced.has(value.id),
    );
    for (const value of createdValues) pendingCreatedValues.delete(value.id);
    const description =
      snapshots.length === 1
        ? `edit to ${details(snapshots[0]!.id).displayTitle}`
        : `previous edit (${snapshots.length} videos)`;
    const batch = { token: randomUUID(), snapshots, createdValues, description };
    undoStack.push(batch);
    if (undoStack.length > undoLimit) undoStack.splice(0, undoStack.length - undoLimit);
    return batch.token;
  }

  return {
    getVideoDetails: details,
    updateVideo(id: string, patch: VideoUpdate): VideoDetails & { undoToken: string | null } {
      let change: UndoSnapshot | null = null;
      try {
        db.transaction(() => {
          const before = snapshot(id, patch);
          setScalars(id, patch);
          if (patch.instructorIds)
            replaceRelations(id, 'video_instructors', 'instructor_id', patch.instructorIds);
          if (patch.tagIds) replaceRelations(id, 'video_tags', 'tag_id', patch.tagIds);
          change = undoSnapshot(before, snapshot(id, patch));
        })();
      } catch (error) {
        pendingCreatedValues.clear();
        throw error;
      }
      const undoToken = remember(change ? [change] : [], patch);
      return { ...details(id), undoToken };
    },
    bulkUpdate(
      ids: readonly string[],
      patch: BulkVideoUpdate,
    ): { changed: number; undoToken: string | null } {
      for (const [add, remove] of [
        [patch.addInstructorIds, patch.removeInstructorIds],
        [patch.addTagIds, patch.removeTagIds],
      ] as const)
        if (add?.some((id) => remove?.includes(id)))
          throw new Error('The same value cannot be both added and removed.');
      let changed = 0;
      const snapshots: UndoSnapshot[] = [];
      try {
        db.transaction(() => {
          const relationKeys = Object.keys(
            relationStatements,
          ) as (keyof typeof relationStatements)[];
          for (const id of ids) {
            if (!exists.get(id)) continue;
            const before = snapshot(id, patch);
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
            const change = undoSnapshot(before, snapshot(id, patch));
            if (change) snapshots.push(change);
          }
        })();
      } catch (error) {
        pendingCreatedValues.clear();
        throw error;
      }
      return { changed, undoToken: remember(snapshots, patch) };
    },
    undoLastEdit(resolveId: (id: string) => string = (id) => id, token?: string) {
      const batch = undoStack.at(-1);
      if (!batch) return null;
      if (token && token !== batch.token) return { status: 'stale' as const };
      let restored = 0;
      let skipped = 0;
      let conflicts = 0;
      let title: string | undefined;
      db.transaction(() => {
        for (const before of batch.snapshots) {
          const id = resolveId(before.id);
          if (!exists.get(id)) {
            skipped++;
            continue;
          }
          const restore: Partial<Record<ScalarKey, unknown>> = {};
          for (const [key, values] of Object.entries(before.scalars) as [
            ScalarKey,
            { before: unknown; after: unknown },
          ][]) {
            const current = snapshot(id, { [key]: null }).scalars[key];
            if (!Object.is(current, values.after)) {
              conflicts++;
              continue;
            }
            if (
              key === 'videoType' &&
              db
                .prepare('SELECT 1 FROM video_links WHERE video_id=? OR other_video_id=? LIMIT 1')
                .get(id, id)
            ) {
              conflicts++;
              continue;
            }
            restore[key] = values.before;
          }
          setScalars(id, restore as VideoUpdate);
          const inverse = (
            delta: RelationDelta | undefined,
            table: 'video_instructors' | 'video_tags',
            column: 'instructor_id' | 'tag_id',
          ) => {
            if (!delta) return;
            const remove = db.prepare(`DELETE FROM ${table} WHERE video_id=? AND ${column}=?`);
            const add = db.prepare(
              `INSERT OR IGNORE INTO ${table}(video_id,${column}) VALUES(?,?)`,
            );
            const relation = column === 'tag_id' ? ('tagIds' as const) : ('instructorIds' as const);
            for (const value of delta.added) {
              if (relationMergedSince(db, id, before.mergeSequence, relation, value)) conflicts++;
              else remove.run(id, value);
            }
            for (const value of delta.removed) {
              const present = Boolean(
                db
                  .prepare(`SELECT 1 FROM ${table} WHERE video_id=? AND ${column}=?`)
                  .get(id, value),
              );
              if (present && relationMergedSince(db, id, before.mergeSequence, relation, value))
                conflicts++;
              else add.run(id, value);
            }
          };
          inverse(before.instructorDelta, 'video_instructors', 'instructor_id');
          inverse(before.tagDelta, 'video_tags', 'tag_id');
          if (!Object.keys(restore).length) touch.run(new Date().toISOString(), id);
          restored++;
          if (batch.snapshots.length === 1) title = details(id).displayTitle;
        }
        for (const value of batch.createdValues) {
          const table = tables[value.kind];
          if (value.kind === 'style')
            db.prepare(
              `DELETE FROM ${table} WHERE id=? AND builtin=0 AND NOT EXISTS (SELECT 1 FROM videos WHERE style_id=?)`,
            ).run(value.id, value.id);
          else {
            const join = value.kind === 'tag' ? 'video_tags' : 'video_instructors';
            const column = value.kind === 'tag' ? 'tag_id' : 'instructor_id';
            db.prepare(
              `DELETE FROM ${table} WHERE id=? AND NOT EXISTS (SELECT 1 FROM ${join} WHERE ${column}=?)`,
            ).run(value.id, value.id);
          }
        }
      })();
      undoStack.pop();
      return {
        status: 'undone' as const,
        restored,
        skipped,
        conflicts,
        title,
        canUndo: undoStack.length > 0,
        undoToken: undoStack.at(-1)?.token,
        undoDescription: undoStack.at(-1)?.description,
      };
    },
    protectedUndoIds(): ReadonlySet<string> {
      return new Set(undoStack.flatMap((batch) => batch.snapshots.map((item) => item.id)));
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
      pendingCreatedValues.set(value.id, { kind, id: value.id });
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
