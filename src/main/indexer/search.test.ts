import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openCatalog } from '../db/catalog';
import { createRepository } from './repository';

const directories: string[] = [];
const databases: Database.Database[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dance-library-search-'));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function open(): Database.Database {
  const db = openCatalog(path.join(tempDir(), 'catalog.sqlite'));
  databases.push(db);
  return db;
}

function addLibrary(db: Database.Database, id: string, label: string): void {
  db.prepare(
    `INSERT INTO libraries (id, path, label, created_at, updated_at)
     VALUES (?, ?, ?, 't', 't')`,
  ).run(id, `/dance/${id}`, label);
}

function addVideo(
  db: Database.Database,
  video: {
    id: string;
    title?: string | null;
    notes?: string | null;
    capturedAt?: string | null;
    durationMs?: number | null;
    videoType?: string | null;
    styleName?: string | null;
    level?: string | null;
    favorite?: number;
    excluded?: number;
    libraryId?: string;
    filename?: string;
    tags?: string[];
    instructors?: string[];
    createdAt?: string;
  },
): void {
  const createdAt = video.createdAt ?? '2024-01-01T00:00:00.000Z';
  let styleId: string | null = null;
  if (video.styleName) {
    styleId =
      (
        db.prepare(`SELECT id FROM styles WHERE name = ? COLLATE NOCASE`).get(video.styleName) as
          { id: string } | undefined
      )?.id ?? null;
    if (!styleId) {
      styleId = `style-${video.styleName.toLowerCase()}`;
      db.prepare(`INSERT INTO styles (id, name, builtin, created_at) VALUES (?, ?, 0, 't')`).run(
        styleId,
        video.styleName,
      );
    }
  }
  db.prepare(
    `INSERT INTO videos (
       id, title, notes, captured_at, duration_ms, video_type, style_id, level, favorite, excluded,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    video.id,
    video.title ?? null,
    video.notes ?? null,
    video.capturedAt ?? null,
    video.durationMs ?? null,
    video.videoType ?? null,
    styleId,
    video.level ?? null,
    video.favorite ?? 0,
    video.excluded ?? 0,
    createdAt,
    createdAt,
  );
  if (video.libraryId && video.filename) {
    db.prepare(
      `INSERT INTO video_locations (
         id, video_id, library_id, path, filename, presence, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'present', 't', 't')`,
    ).run(
      `${video.id}-loc`,
      video.id,
      video.libraryId,
      `/dance/${video.libraryId}/${video.filename}`,
      video.filename,
    );
  }
  for (const name of video.tags ?? []) {
    db.prepare(`INSERT OR IGNORE INTO tags (id, name, created_at) VALUES (?, ?, 't')`).run(
      `tag-${name.toLowerCase()}`,
      name,
    );
    db.prepare(`INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)`).run(
      video.id,
      `tag-${name.toLowerCase()}`,
    );
  }
  for (const name of video.instructors ?? []) {
    db.prepare(`INSERT OR IGNORE INTO instructors (id, name, created_at) VALUES (?, ?, 't')`).run(
      `inst-${name.toLowerCase()}`,
      name,
    );
    db.prepare(`INSERT INTO video_instructors (video_id, instructor_id) VALUES (?, ?)`).run(
      video.id,
      `inst-${name.toLowerCase()}`,
    );
  }
}

describe('catalog search', () => {
  it('finds videos by title, notes, tags, and the filename used as a title', () => {
    const db = open();
    addLibrary(db, 'lib', 'dance');
    addVideo(db, {
      id: 'titled',
      title: 'Zouk lady styling',
      libraryId: 'lib',
      filename: 'clip.mp4',
    });
    addVideo(db, {
      id: 'noted',
      title: 'Warmup',
      notes: 'Practice the lateral bounce',
      libraryId: 'lib',
      filename: 'warmup.mp4',
    });
    addVideo(db, {
      id: 'tagged',
      title: 'Social',
      tags: ['body wave'],
      libraryId: 'lib',
      filename: 'social.mp4',
    });
    addVideo(db, {
      id: 'named',
      libraryId: 'lib',
      filename: 'kizomba-demo.mp4',
    });
    addVideo(db, {
      id: 'other',
      title: 'Waltz frame',
      libraryId: 'lib',
      filename: 'waltz.mp4',
    });
    const repo = createRepository(db);

    expect(repo.listVideoSummaries({ text: 'zouk' }).map((item) => item.id)).toEqual(['titled']);
    expect(repo.listVideoSummaries({ text: 'lateral' }).map((item) => item.id)).toEqual(['noted']);
    expect(repo.listVideoSummaries({ text: 'body wave' }).map((item) => item.id)).toEqual([
      'tagged',
    ]);
    expect(repo.listVideoSummaries({ text: 'kizomba' }).map((item) => item.id)).toEqual(['named']);
    expect(repo.listVideoSummaries({ text: 'forró' }).map((item) => item.id)).toEqual([]);
    expect(repo.listVideoSummaries({ text: '" OR 1=1 --' })).toEqual([]);
  });

  it('matches accented words without the accent and keeps the index current', () => {
    const db = open();
    addLibrary(db, 'lib', 'dance');
    addVideo(db, { id: 'vid', title: 'Forró class', libraryId: 'lib', filename: 'a.mp4' });
    const repo = createRepository(db);
    expect(repo.listVideoSummaries({ text: 'forro' }).map((item) => item.id)).toEqual(['vid']);

    db.prepare(
      `UPDATE videos SET title = 'Samba class', notes = 'gafieira walk' WHERE id = 'vid'`,
    ).run();
    expect(repo.listVideoSummaries({ text: 'forro' })).toEqual([]);
    expect(repo.listVideoSummaries({ text: 'gafieira' }).map((item) => item.id)).toEqual(['vid']);

    db.prepare(
      `INSERT INTO tags (id, name, created_at) VALUES ('tag-wave', 'body wave', 't')`,
    ).run();
    db.prepare(`INSERT INTO video_tags (video_id, tag_id) VALUES ('vid', 'tag-wave')`).run();
    expect(repo.listVideoSummaries({ text: 'wave' }).map((item) => item.id)).toEqual(['vid']);
    db.prepare(`DELETE FROM video_tags WHERE video_id = 'vid'`).run();
    expect(repo.listVideoSummaries({ text: 'wave' })).toEqual([]);
  });

  it('combines filters and does not return excluded videos unless asked', () => {
    const db = open();
    addLibrary(db, 'drive', 'Backup');
    addLibrary(db, 'takeout', 'Takeout');
    const zouk = db.prepare(`SELECT id FROM styles WHERE name = 'Zouk'`).get() as { id: string };
    addVideo(db, {
      id: 'match',
      title: 'Lady styling',
      capturedAt: '2024-06-15T18:00:00.000Z',
      durationMs: 12 * 60 * 1000,
      videoType: 'lesson',
      styleName: 'Zouk',
      level: 'Intermediate',
      favorite: 1,
      libraryId: 'drive',
      filename: 'lesson.mp4',
      tags: ['styling'],
      instructors: ['Aline'],
    });
    addVideo(db, {
      id: 'hidden',
      title: 'Lady styling secret',
      capturedAt: '2024-06-15T18:00:00.000Z',
      durationMs: 12 * 60 * 1000,
      videoType: 'lesson',
      styleName: 'Zouk',
      level: 'Intermediate',
      favorite: 1,
      excluded: 1,
      libraryId: 'drive',
      filename: 'secret.mp4',
      tags: ['styling'],
      instructors: ['Aline'],
    });
    addVideo(db, {
      id: 'other-day',
      title: 'Lady styling',
      capturedAt: '2023-01-01T00:00:00.000Z',
      durationMs: 12 * 60 * 1000,
      videoType: 'lesson',
      styleName: 'Zouk',
      level: 'Intermediate',
      favorite: 1,
      libraryId: 'drive',
      filename: 'old.mp4',
      tags: ['styling'],
      instructors: ['Aline'],
    });
    const repo = createRepository(db);
    const found = repo.listVideoSummaries({
      text: 'styling',
      capturedFrom: '2024-06-01',
      capturedTo: '2024-06-30',
      videoTypes: ['lesson'],
      styleIds: [zouk.id],
      levels: ['Intermediate'],
      tagIds: [repo.listFacets().tags.find((tag) => tag.name === 'styling')?.id ?? ''],
      instructorIds: [repo.listFacets().instructors[0]?.id ?? ''],
      libraryIds: ['drive'],
      durationMinMs: 5 * 60 * 1000,
      durationMaxMs: 20 * 60 * 1000,
      favorite: true,
    });
    expect(found.map((item) => item.id)).toEqual(['match']);
    expect(found[0]).toMatchObject({
      videoType: 'lesson',
      styleName: 'Zouk',
      level: 'Intermediate',
      favorite: true,
      instructors: ['Aline'],
      tags: ['styling'],
      displayTitle: 'Lady styling',
    });
    expect(repo.listVideoSummaries({ excluded: true }).map((item) => item.id)).toEqual(['hidden']);
    expect(zouk.id).toBe('builtin:zouk');
  });

  it('sorts by capture date, title, and duration', () => {
    const db = open();
    addLibrary(db, 'lib', 'dance');
    addVideo(db, {
      id: 'new',
      title: 'Bravo',
      capturedAt: '2024-08-01T00:00:00.000Z',
      durationMs: 1000,
      libraryId: 'lib',
      filename: 'b.mp4',
    });
    addVideo(db, {
      id: 'old',
      title: 'Alpha',
      capturedAt: '2020-01-01T00:00:00.000Z',
      durationMs: 9000,
      libraryId: 'lib',
      filename: 'a.mp4',
    });
    addVideo(db, {
      id: 'undated',
      title: 'Charlie',
      durationMs: 5000,
      libraryId: 'lib',
      filename: 'c.mp4',
    });
    const repo = createRepository(db);
    expect(repo.listVideoSummaries({ sort: 'newest' }).map((item) => item.id)).toEqual([
      'new',
      'old',
      'undated',
    ]);
    expect(repo.listVideoSummaries({ sort: 'oldest' }).map((item) => item.id)).toEqual([
      'old',
      'new',
      'undated',
    ]);
    expect(repo.listVideoSummaries({ sort: 'title' }).map((item) => item.id)).toEqual([
      'old',
      'new',
      'undated',
    ]);
    expect(repo.listVideoSummaries({ sort: 'longest' }).map((item) => item.id)).toEqual([
      'old',
      'undated',
      'new',
    ]);
  });

  it('filters a few thousand videos quickly', () => {
    const db = open();
    addLibrary(db, 'lib', 'dance');
    const insert = db.prepare(
      `INSERT INTO videos (id, title, video_type, duration_ms, captured_at, created_at, updated_at)
       VALUES (@id, @title, @videoType, @durationMs, @capturedAt, @createdAt, @createdAt)`,
    );
    const seed = db.transaction(() => {
      for (let index = 0; index < 3000; index += 1) {
        const lesson = index % 20 === 0;
        insert.run({
          id: `v${index}`,
          title: lesson ? `Zouk lesson ${index}` : `Clip ${index}`,
          videoType: lesson ? 'lesson' : 'social dance',
          durationMs: 60_000,
          capturedAt: '2024-01-01T00:00:00.000Z',
          createdAt: '2024-01-01T00:00:00.000Z',
        });
      }
    });
    seed();
    const repo = createRepository(db);
    const started = performance.now();
    const found = repo.listVideoSummaries({ text: 'zouk lesson', videoTypes: ['lesson'] });
    const elapsed = performance.now() - started;
    expect(found).toHaveLength(150);
    expect(elapsed).toBeLessThan(250);
  });
});
