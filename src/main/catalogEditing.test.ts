import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './db/migrate';
import { createCatalogEditor } from './catalogEditing';
import { createRepository } from './indexer/repository';
import { repairSearchIndex } from './db/searchIndex';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  migrate(db);
  db.prepare(
    `INSERT INTO libraries(id,path,label,created_at,updated_at) VALUES('lib','/dance','dance',?,?)`,
  ).run(now, now);
  for (const [id, type, name] of [
    ['lesson', 'lesson', 'lesson.mp4'],
    ['demo', 'demo', 'demo.mp4'],
    ['other', null, 'other.mp4'],
  ] as const) {
    db.prepare(`INSERT INTO videos(id,video_type,created_at,updated_at) VALUES(?,?,?,?)`).run(
      id,
      type,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO video_locations(id,video_id,library_id,path,path_key,filename,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`,
    ).run(`loc-${id}`, id, 'lib', `/dance/${name}`, `/dance/${name}`, name, now, now);
  }
});
afterEach(() => db.close());
const now = '2024-01-01T00:00:00.000Z';

describe('catalog editing', () => {
  it('updates all details and keeps date-only values unchanged', () => {
    const e = createCatalogEditor(db);
    const style = e.createValue('style', 'My Style');
    const teacher = e.createValue('instructor', 'Alice');
    const tag = e.createValue('tag', 'Body wave');
    const d = e.updateVideo('lesson', {
      title: '  Basics  ',
      styleId: style.id,
      instructorIds: [teacher.id],
      tagIds: [tag.id],
      eventName: 'Congress',
      eventDate: '2024-03-10',
      rating: 5,
      favorite: true,
      notes: 'Practice',
    });
    expect(d).toMatchObject({
      title: '  Basics  ',
      eventDate: '2024-03-10',
      rating: 5,
      favorite: true,
    });
    expect(d.instructors.map((x) => x.name)).toEqual(['Alice']);
    expect(d.tags.map((x) => x.name)).toEqual(['Body wave']);
  });
  it('deduplicates values case-insensitively and searches contains with prefix first', () => {
    const e = createCatalogEditor(db);
    expect(e.createValue('tag', '  Musicality ').id).toBe(e.createValue('tag', 'musicality').id);
    e.createValue('tag', 'Advanced musicality');
    expect(e.searchValues('tag', 'music').map((x) => x.name)).toEqual([
      'Musicality',
      'Advanced musicality',
    ]);
    expect(() => e.createValue('tag', '  ')).toThrow(/1 to 120/);
  });
  it('bulk sets touched scalars and adds/removes relations without clobbering others', () => {
    const e = createCatalogEditor(db);
    const a = e.createValue('tag', 'A'),
      b = e.createValue('tag', 'B');
    e.updateVideo('lesson', { tagIds: [a.id] });
    e.updateVideo('demo', { tagIds: [a.id, b.id] });
    expect(
      e.bulkUpdate(['lesson', 'demo'], { title: 'Batch', addTagIds: [b.id], removeTagIds: [a.id] }),
    ).toMatchObject({ changed: 2 });
    expect(e.getVideoDetails('lesson').tags.map((x) => x.name)).toEqual(['B']);
    expect(e.getVideoDetails('demo').tags.map((x) => x.name)).toEqual(['B']);
    expect(e.getVideoDetails('lesson').videoType).toBe('lesson');
  });
  it('stores lesson-to-demo links, shows both sides, and rejects self, reverse types, and duplicates', () => {
    const e = createCatalogEditor(db);
    e.linkLessonDemo('lesson', 'demo');
    expect(e.getVideoDetails('lesson').lessonDemos[0]?.id).toBe('demo');
    expect(e.getVideoDetails('demo').lessonDemos[0]?.id).toBe('lesson');
    expect(() => e.linkLessonDemo('lesson', 'lesson')).toThrow(/itself/);
    expect(() => e.linkLessonDemo('demo', 'lesson')).toThrow(/lesson to a demo/);
    expect(() => e.linkLessonDemo('lesson', 'demo')).toThrow(/already linked/);
    e.unlinkLessonDemo('lesson', 'demo');
    expect(e.getVideoDetails('lesson').lessonDemos).toEqual([]);
  });
  it('unlinks an unordered pair and blocks retyping while linked', () => {
    const e = createCatalogEditor(db);
    e.linkLessonDemo('lesson', 'demo');
    expect(() => e.updateVideo('lesson', { videoType: 'lesson' })).not.toThrow();
    expect(() => e.updateVideo('lesson', { videoType: 'social dance' })).toThrow(/Unlink/);
    e.unlinkLessonDemo('demo', 'lesson');
    expect(e.getVideoDetails('lesson').lessonDemos).toEqual([]);
  });
  it('rejects links to excluded videos', () => {
    const e = createCatalogEditor(db);
    db.prepare(`UPDATE videos SET excluded=1, excluded_at=? WHERE id='demo'`).run(now);
    expect(() => e.linkLessonDemo('lesson', 'demo')).toThrow(/Restore excluded/);
  });
  it('searches edited title, style, event, instructor, tag, and notes', () => {
    const e = createCatalogEditor(db),
      repo = createRepository(db);
    const style = e.createValue('style', 'Brazilian Zouk'),
      teacher = e.createValue('instructor', 'Alice'),
      tag = e.createValue('tag', 'Viradinha');
    e.updateVideo('lesson', {
      title: 'Foundations',
      styleId: style.id,
      eventName: 'Summer Congress',
      instructorIds: [teacher.id],
      tagIds: [tag.id],
      notes: 'Elasticity',
    });
    for (const term of ['Foundations', 'Brazilian', 'Congress', 'Alice', 'Viradinha', 'Elasticity'])
      expect(
        repo.listVideoSummaries({ text: term }).map((x) => x.id),
        term,
      ).toContain('lesson');
  });
  it('repairs composite search and removes cleared style and instructor terms', () => {
    const e = createCatalogEditor(db),
      repo = createRepository(db);
    const style = e.createValue('style', 'Repair Zouk'),
      teacher = e.createValue('instructor', 'Repair Alice');
    e.updateVideo('lesson', {
      styleId: style.id,
      eventName: 'Repair Congress',
      instructorIds: [teacher.id],
    });
    db.prepare(
      `DELETE FROM videos_fts WHERE rowid=(SELECT rowid FROM video_search_keys WHERE video_id='lesson')`,
    ).run();
    repairSearchIndex(db);
    for (const term of ['Repair', 'Congress', 'Alice'])
      expect(repo.listVideoSummaries({ text: term }).map((x) => x.id)).toContain('lesson');
    e.updateVideo('lesson', { styleId: null, instructorIds: [] });
    expect(repo.listVideoSummaries({ text: 'Zouk' }).map((x) => x.id)).not.toContain('lesson');
    expect(repo.listVideoSummaries({ text: 'Alice' }).map((x) => x.id)).not.toContain('lesson');
  });
  it('keeps edits shared by every location and technical rescans do not overwrite them', () => {
    const e = createCatalogEditor(db),
      repo = createRepository(db);
    e.updateVideo('lesson', { title: 'Edited', notes: 'Keep me' });
    db.prepare(
      `INSERT INTO video_locations(id,video_id,library_id,path,path_key,filename,created_at,updated_at) VALUES('copy','lesson','lib','/dance/copy.mp4','/dance/copy.mp4','copy.mp4',?,?)`,
    ).run(now, now);
    const record = repo.getVideo('lesson')!;
    repo.updateVideoTechnical({
      id: 'lesson',
      contentHash: record.contentHash,
      contentHashKind: record.contentHashKind,
      fullHash: null,
      fullHashKind: null,
      sizeBytes: 1,
      durationMs: 2,
      width: 3,
      height: 4,
      videoCodec: 'h264',
      container: 'mp4',
      capturedAt: null,
      capturedAtSource: null,
      metadataCreatedAt: null,
      metadataError: null,
      thumbnailFile: null,
      now,
    });
    expect(e.getVideoDetails('lesson')).toMatchObject({ title: 'Edited', notes: 'Keep me' });
    expect(repo.listVideoSummaries({}).find((x) => x.id === 'lesson')?.locations).toHaveLength(2);
  });

  it('undoes one edit exactly, including relations, nulls, and the search index', () => {
    let e = createCatalogEditor(db);
    const oldStyle = e.createValue('style', 'Old Zouk');
    const newStyle = e.createValue('style', 'New Samba');
    const oldTeacher = e.createValue('instructor', 'Old Alice');
    const newTeacher = e.createValue('instructor', 'New Bob');
    const oldTag = e.createValue('tag', 'Old Elasticity');
    const newTag = e.createValue('tag', 'New Spins');
    e.updateVideo('lesson', {
      title: 'Old title',
      styleId: oldStyle.id,
      instructorIds: [oldTeacher.id],
      tagIds: [oldTag.id],
      eventDate: null,
      rating: 2,
      favorite: false,
      notes: 'Old searchable notes',
    });
    e = createCatalogEditor(db);
    e.updateVideo('lesson', {
      title: 'New title',
      styleId: newStyle.id,
      instructorIds: [newTeacher.id],
      tagIds: [newTag.id],
      eventDate: '2025-08-19',
      rating: 5,
      favorite: true,
      notes: 'New searchable notes',
    });
    expect(e.undoLastEdit()).toMatchObject({
      status: 'undone',
      restored: 1,
      skipped: 0,
      conflicts: 0,
    });
    expect(e.getVideoDetails('lesson')).toMatchObject({
      title: 'Old title',
      style: { name: 'Old Zouk' },
      eventDate: null,
      rating: 2,
      favorite: false,
      notes: 'Old searchable notes',
    });
    expect(e.getVideoDetails('lesson').instructors.map((x) => x.name)).toEqual(['Old Alice']);
    expect(e.getVideoDetails('lesson').tags.map((x) => x.name)).toEqual(['Old Elasticity']);
    const repo = createRepository(db);
    for (const term of ['Old searchable', 'Old Zouk', 'Old Alice', 'Old Elasticity'])
      expect(
        repo.listVideoSummaries({ text: term }).map((x) => x.id),
        term,
      ).toContain('lesson');
    for (const term of ['New title', 'New Samba', 'New Bob', 'New Spins', 'New searchable'])
      expect(
        repo.listVideoSummaries({ text: term }).map((x) => x.id),
        term,
      ).not.toContain('lesson');
  });

  it('bulk undo restores each video own values and leaves untouched fields alone', () => {
    let e = createCatalogEditor(db);
    const a = e.createValue('tag', 'A');
    const b = e.createValue('tag', 'B');
    const alice = e.createValue('instructor', 'Alice');
    const bob = e.createValue('instructor', 'Bob');
    const zouk = e.createValue('style', 'Bulk Zouk');
    const samba = e.createValue('style', 'Bulk Samba');
    e.updateVideo('lesson', {
      title: 'Lesson before',
      styleId: zouk.id,
      instructorIds: [alice.id],
      tagIds: [a.id],
      eventDate: null,
      rating: 1,
      favorite: false,
      notes: 'Keep lesson',
    });
    e.updateVideo('demo', {
      title: 'Demo before',
      styleId: samba.id,
      instructorIds: [bob.id],
      tagIds: [b.id],
      eventDate: '2024-05-01',
      rating: 4,
      favorite: true,
      notes: 'Keep demo',
    });
    e = createCatalogEditor(db);
    e.bulkUpdate(['lesson', 'demo'], {
      title: 'Batch title',
      styleId: zouk.id,
      eventDate: '2026-02-14',
      rating: 5,
      favorite: true,
      addTagIds: [b.id],
      removeTagIds: [a.id],
      addInstructorIds: [bob.id],
      removeInstructorIds: [alice.id],
    });
    db.prepare(
      `UPDATE videos SET notes='Changed later outside touched fields' WHERE id='lesson'`,
    ).run();
    expect(e.undoLastEdit()).toMatchObject({
      status: 'undone',
      restored: 2,
      skipped: 0,
      conflicts: 0,
    });
    expect(e.getVideoDetails('lesson')).toMatchObject({
      title: 'Lesson before',
      style: { name: 'Bulk Zouk' },
      eventDate: null,
      rating: 1,
      favorite: false,
      notes: 'Changed later outside touched fields',
    });
    expect(e.getVideoDetails('demo')).toMatchObject({
      title: 'Demo before',
      style: { name: 'Bulk Samba' },
      eventDate: '2024-05-01',
      rating: 4,
      favorite: true,
      notes: 'Keep demo',
    });
    expect(e.getVideoDetails('lesson').instructors.map((x) => x.name)).toEqual(['Alice']);
    expect(e.getVideoDetails('demo').instructors.map((x) => x.name)).toEqual(['Bob']);
    expect(e.getVideoDetails('lesson').tags.map((x) => x.name)).toEqual(['A']);
    expect(e.getVideoDetails('demo').tags.map((x) => x.name)).toEqual(['B']);
  });

  it('undoes strictly LIFO and keeps only the configured number of batches', () => {
    const e = createCatalogEditor(db, 2);
    e.updateVideo('lesson', { title: 'One' });
    e.updateVideo('lesson', { title: 'Two' });
    e.updateVideo('lesson', { title: 'Three' });
    expect(e.undoLastEdit()).toMatchObject({ status: 'undone', restored: 1, skipped: 0 });
    expect(e.getVideoDetails('lesson').title).toBe('Two');
    expect(e.undoLastEdit()).toMatchObject({ status: 'undone', restored: 1, skipped: 0 });
    expect(e.getVideoDetails('lesson').title).toBe('One');
    expect(e.undoLastEdit()).toBeNull();
  });

  it('restores content metadata once for every location', () => {
    const e = createCatalogEditor(db);
    db.prepare(
      `INSERT INTO video_locations(id,video_id,library_id,path,path_key,filename,created_at,updated_at)
       VALUES('copy-undo','lesson','lib','/dance/copy-undo.mp4','/dance/copy-undo.mp4','copy-undo.mp4',?,?)`,
    ).run(now, now);
    e.updateVideo('lesson', { title: 'Across copies' });
    expect(e.undoLastEdit()).toMatchObject({ status: 'undone', restored: 1, skipped: 0 });
    const item = createRepository(db)
      .listVideoSummaries({})
      .find((x) => x.id === 'lesson');
    expect(item?.title).toBeNull();
    expect(item?.locations.map((location) => location.filename)).toEqual([
      'copy-undo.mp4',
      'lesson.mp4',
    ]);
  });

  it('preserves later scalar changes and scan-merged relations while reporting conflicts', () => {
    const e = createCatalogEditor(db);
    const edited = e.createValue('tag', 'Edited tag');
    const scanned = e.createValue('tag', 'Scanned tag');
    e.updateVideo('lesson', { title: 'Saved title', tagIds: [edited.id] });
    db.prepare(`UPDATE videos SET title='Changed later' WHERE id='lesson'`).run();
    db.prepare(`INSERT INTO video_tags(video_id,tag_id) VALUES('lesson',?)`).run(scanned.id);
    expect(e.undoLastEdit()).toMatchObject({ restored: 1, conflicts: 1 });
    expect(e.getVideoDetails('lesson').title).toBe('Changed later');
    expect(e.getVideoDetails('lesson').tags.map((value) => value.name)).toEqual(['Scanned tag']);
  });

  it('keeps an added tag when a later duplicate merge brings it into the kept video', () => {
    const e = createCatalogEditor(db);
    const tag = e.createValue('tag', 'Shared by duplicate');
    e.updateVideo('lesson', { tagIds: [tag.id] });
    db.prepare(`INSERT INTO video_tags(video_id,tag_id) VALUES('demo',?)`).run(tag.id);

    createRepository(db).mergeVideos('lesson', ['demo'], '2024-01-02T00:00:00.000Z');

    expect(e.undoLastEdit()).toMatchObject({ restored: 1, conflicts: 1 });
    expect(e.getVideoDetails('lesson').tags.map((value) => value.name)).toEqual([
      'Shared by duplicate',
    ]);
  });

  it('restores the rest of a linked video and keeps the history entry until commit', () => {
    const e = createCatalogEditor(db);
    const tag = e.createValue('tag', 'Linked edit');
    e.updateVideo('other', { title: 'Before', videoType: 'social dance' });
    const save = e.updateVideo('other', {
      title: 'After',
      videoType: 'lesson',
      tagIds: [tag.id],
    });
    e.linkLessonDemo('other', 'demo');
    expect(e.undoLastEdit(undefined, save.undoToken!)).toMatchObject({
      status: 'undone',
      restored: 1,
      conflicts: 1,
    });
    expect(e.getVideoDetails('other')).toMatchObject({ title: 'Before', videoType: 'lesson' });
    expect(e.getVideoDetails('other').tags).toEqual([]);
  });

  it('does not record no-op saves and rejects a stale notice token', () => {
    const e = createCatalogEditor(db);
    const first = e.updateVideo('lesson', { title: 'One' });
    expect(e.updateVideo('lesson', { title: 'One' }).undoToken).toBeNull();
    const second = e.updateVideo('demo', { title: 'Two' });
    expect(e.undoLastEdit(undefined, first.undoToken!)).toEqual({ status: 'stale' });
    expect(e.undoLastEdit(undefined, second.undoToken!)).toMatchObject({ status: 'undone' });
  });

  it('describes the next undo target after an undo', () => {
    const e = createCatalogEditor(db);
    e.updateVideo('lesson', { title: 'B' });
    e.updateVideo('demo', { title: 'A' });
    expect(e.undoLastEdit()).toMatchObject({
      undoDescription: 'edit to B',
      canUndo: true,
    });
  });

  it('does not attach created values from failed or no-op saves to a later undo', () => {
    const e = createCatalogEditor(db);
    const afterFailure = e.createValue('tag', 'After failure');
    expect(() => e.updateVideo('missing', { tagIds: [afterFailure.id] })).toThrow();
    e.updateVideo('lesson', { tagIds: [afterFailure.id] });
    e.undoLastEdit();
    expect(e.searchValues('tag', 'After failure')).toHaveLength(1);

    const afterNoop = e.createValue('tag', 'After no-op');
    expect(e.updateVideo('lesson', { title: null }).undoToken).toBeNull();
    e.updateVideo('lesson', { tagIds: [afterNoop.id] });
    e.undoLastEdit();
    expect(e.searchValues('tag', 'After no-op')).toHaveLength(1);
  });

  it('deletes values created by an undone save only when unreferenced', () => {
    const e = createCatalogEditor(db);
    const style = e.createValue('style', 'Ephemeral style');
    const teacher = e.createValue('instructor', 'Ephemeral teacher');
    const tag = e.createValue('tag', 'Ephemeral tag');
    e.updateVideo('lesson', {
      styleId: style.id,
      instructorIds: [teacher.id],
      tagIds: [tag.id],
    });
    expect(e.undoLastEdit()).toMatchObject({ status: 'undone' });
    expect(e.searchValues('style', 'Ephemeral')).toEqual([]);
    expect(e.searchValues('instructor', 'Ephemeral')).toEqual([]);
    expect(e.searchValues('tag', 'Ephemeral')).toEqual([]);
  });
});
