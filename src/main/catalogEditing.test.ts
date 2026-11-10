import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './db/migrate';
import { createCatalogEditor } from './catalogEditing';
import { createRepository } from './indexer/repository';

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
    ).toBe(2);
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
});
