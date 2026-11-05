import type Database from 'better-sqlite3';
import { pathKey } from './paths';
import {
  thumbnailUrl,
  type CaptureDateSource,
  type CatalogFacets,
  type Level,
  type LibrarySummary,
  type VideoListItem,
  type VideoLocationItem,
  type VideoQuery,
  type VideoType,
} from '../../shared/api';
import { videoListQuery } from './videoQuery';

export type LibraryRecord = {
  id: string;
  path: string;
  volumeId: string | null;
  volumeRelPath: string | null;
  label: string;
  availability: 'online' | 'offline';
  scanGeneration: number;
  lastScannedAt: string | null;
  lastError: string | null;
};

export type LocationRecord = {
  id: string;
  videoId: string;
  libraryId: string;
  path: string;
  filename: string;
  volumeId: string | null;
  fileId: string | null;
  sizeBytes: number | null;
  mtimeNs: string | null;
  presence: 'present' | 'missing';
  createdAt: string;
};

export type VideoRecord = {
  id: string;
  contentHash: string | null;
  contentHashKind: string | null;
  fullHash: string | null;
  sizeBytes: number | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  container: string | null;
  capturedAt: string | null;
  capturedAtSource: CaptureDateSource | null;
  metadataCreatedAt: string | null;
  metadataError: string | null;
  thumbnailFile: string | null;
  excluded: number;
  createdAt: string;
};

export type VideoWrite = {
  id: string;
  contentHash: string | null;
  contentHashKind: string | null;
  fullHash: string | null;
  fullHashKind: string | null;
  sizeBytes: number | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  container: string | null;
  capturedAt: string | null;
  capturedAtSource: CaptureDateSource | null;
  metadataCreatedAt: string | null;
  metadataError: string | null;
  thumbnailFile: string | null;
  now: string;
};

export type LocationWrite = {
  id: string;
  videoId: string;
  libraryId: string;
  path: string;
  filename: string;
  volumeId: string | null;
  fileId: string | null;
  sizeBytes: number | null;
  mtimeNs: string | null;
  fileCreatedAt: string | null;
  fileModifiedAt: string | null;
  generation: number;
  now: string;
};

const LIBRARY_SELECT = `
  SELECT
    id, path, volume_id AS volumeId, volume_rel_path AS volumeRelPath, label, availability,
    scan_generation AS scanGeneration, last_scanned_at AS lastScannedAt, last_error AS lastError
  FROM libraries
`;

const LOCATION_SELECT = `
  SELECT
    id, video_id AS videoId, library_id AS libraryId, path, filename,
    volume_id AS volumeId, file_id AS fileId, size_bytes AS sizeBytes, mtime_ns AS mtimeNs,
    presence, created_at AS createdAt
  FROM video_locations
`;

const VIDEO_SELECT = `
  SELECT
    id, content_hash AS contentHash, content_hash_kind AS contentHashKind, full_hash AS fullHash,
    size_bytes AS sizeBytes, duration_ms AS durationMs, width, height,
    video_codec AS videoCodec, container, captured_at AS capturedAt,
    captured_at_source AS capturedAtSource, metadata_created_at AS metadataCreatedAt,
    metadata_error AS metadataError, thumbnail_file AS thumbnailFile, excluded,
    created_at AS createdAt
  FROM videos
`;

export function createRepository(db: Database.Database) {
  const libraryById = db.prepare(`${LIBRARY_SELECT} WHERE id = ?`);
  const libraries = db.prepare(`${LIBRARY_SELECT} ORDER BY label COLLATE NOCASE, path`);
  const insertLibraryStmt = db.prepare(`
    INSERT INTO libraries (id, path, label, availability, created_at, updated_at)
    VALUES (@id, @path, @label, 'online', @now, @now)
  `);
  const locationsByIdentity = db.prepare(
    `${LOCATION_SELECT} WHERE volume_id = ? AND file_id = ? ORDER BY created_at, id`,
  );
  const locationByPathKey = db.prepare(`${LOCATION_SELECT} WHERE path_key = ?`);
  const locationByPath = db.prepare(`${LOCATION_SELECT} WHERE path = ?`);
  const videoById = db.prepare(`${VIDEO_SELECT} WHERE id = ?`);
  const videosByHash = db.prepare(
    `${VIDEO_SELECT} WHERE content_hash = ? AND size_bytes = ? ORDER BY created_at, id`,
  );
  const locationsForVideoStmt = db.prepare(
    `${LOCATION_SELECT} WHERE video_id = ? ORDER BY created_at, id`,
  );

  const insertVideoStmt = db.prepare(`
    INSERT INTO videos (
      id, content_hash, content_hash_kind, full_hash, full_hash_kind, size_bytes,
      duration_ms, width, height, video_codec, container, captured_at, captured_at_source,
      metadata_created_at, metadata_error, thumbnail_file, created_at, updated_at
    ) VALUES (
      @id, @contentHash, @contentHashKind, @fullHash, @fullHashKind, @sizeBytes,
      @durationMs, @width, @height, @videoCodec, @container, @capturedAt, @capturedAtSource,
      @metadataCreatedAt, @metadataError, @thumbnailFile, @now, @now
    )
  `);
  const updateVideoStmt = db.prepare(`
    UPDATE videos SET
      content_hash = @contentHash,
      content_hash_kind = @contentHashKind,
      full_hash = COALESCE(@fullHash, full_hash),
      full_hash_kind = COALESCE(@fullHashKind, full_hash_kind),
      size_bytes = @sizeBytes,
      duration_ms = @durationMs,
      width = @width,
      height = @height,
      video_codec = @videoCodec,
      container = @container,
      captured_at = @capturedAt,
      captured_at_source = @capturedAtSource,
      metadata_created_at = @metadataCreatedAt,
      metadata_error = @metadataError,
      thumbnail_file = COALESCE(@thumbnailFile, thumbnail_file),
      updated_at = @now
    WHERE id = @id
  `);
  const insertLocationStmt = db.prepare(`
    INSERT INTO video_locations (
      id, video_id, library_id, path, path_key, filename, volume_id, file_id, size_bytes, mtime_ns,
      file_created_at, file_modified_at, presence, last_scan_generation, created_at, updated_at
    ) VALUES (
      @id, @videoId, @libraryId, @path, @pathKey, @filename, @volumeId, @fileId, @sizeBytes, @mtimeNs,
      @fileCreatedAt, @fileModifiedAt, 'present', @generation, @now, @now
    )
  `);
  const updateLocationStmt = db.prepare(`
    UPDATE video_locations SET
      video_id = @videoId,
      library_id = @libraryId,
      path = @path,
      path_key = @pathKey,
      filename = @filename,
      volume_id = @volumeId,
      file_id = @fileId,
      size_bytes = @sizeBytes,
      mtime_ns = @mtimeNs,
      file_created_at = @fileCreatedAt,
      file_modified_at = @fileModifiedAt,
      presence = 'present',
      last_scan_generation = @generation,
      updated_at = @now
    WHERE id = @id
  `);

  return {
    getLibrary(id: string): LibraryRecord | null {
      return (libraryById.get(id) as LibraryRecord | undefined) ?? null;
    },

    listLibraries(): LibraryRecord[] {
      return libraries.all() as LibraryRecord[];
    },

    insertLibrary(input: { id: string; path: string; label: string; now: string }): LibraryRecord {
      insertLibraryStmt.run(input);
      const library = libraryById.get(input.id) as LibraryRecord | undefined;
      if (!library) throw new Error('Library insert did not persist');
      return library;
    },

    beginScan(
      id: string,
      resolved: { path: string; volumeId: string | null; volumeRelPath: string | null },
      now: string,
    ): number {
      db.prepare(
        `UPDATE libraries
         SET path = ?, volume_id = ?, volume_rel_path = ?, availability = 'online',
             scan_generation = scan_generation + 1, last_error = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(resolved.path, resolved.volumeId, resolved.volumeRelPath, now, id);
      const row = db
        .prepare(`SELECT scan_generation AS generation FROM libraries WHERE id = ?`)
        .get(id) as { generation: number } | undefined;
      if (!row) throw new Error(`Library ${id} disappeared during scan`);
      return row.generation;
    },

    markOffline(id: string, now: string): void {
      db.prepare(
        `UPDATE libraries SET availability = 'offline', last_error = NULL, updated_at = ? WHERE id = ?`,
      ).run(now, id);
    },

    markUnreadable(id: string, message: string, now: string): void {
      db.prepare(`UPDATE libraries SET last_error = ?, updated_at = ? WHERE id = ?`).run(
        message,
        now,
        id,
      );
    },

    finishScan(id: string, now: string): void {
      db.prepare(
        `UPDATE libraries
         SET last_scanned_at = ?, updated_at = ?, last_error = NULL, availability = 'online'
         WHERE id = ?`,
      ).run(now, now, id);
    },

    findLocationsByIdentity(volumeId: string, fileId: string): LocationRecord[] {
      return locationsByIdentity.all(volumeId, fileId) as LocationRecord[];
    },

    findLocationByPath(filePath: string): LocationRecord | null {
      const byKey = locationByPathKey.get(pathKey(filePath)) as LocationRecord | undefined;
      if (byKey) return byKey;
      return (locationByPath.get(filePath) as LocationRecord | undefined) ?? null;
    },

    findVideoByFullHash(hash: string): VideoRecord | null {
      return (
        (db.prepare(`${VIDEO_SELECT} WHERE full_hash = ?`).get(hash) as VideoRecord | undefined) ??
        null
      );
    },

    locationsForLibrary(libraryId: string): LocationRecord[] {
      return db
        .prepare(`${LOCATION_SELECT} WHERE library_id = ?`)
        .all(libraryId) as LocationRecord[];
    },

    samplePresentLocations(libraryId: string, limit: number): LocationRecord[] {
      return takeLocationSample(db, libraryId, limit, 'present');
    },

    sampleLocations(libraryId: string, limit: number): LocationRecord[] {
      return takeLocationSample(db, libraryId, limit, null);
    },

    countLocations(libraryId: string): number {
      const row = db
        .prepare(`SELECT COUNT(*) AS count FROM video_locations WHERE library_id = ?`)
        .get(libraryId) as { count: number };
      return row.count;
    },

    resolveVideoId(id: string): string {
      let current = id;
      const lookup = db.prepare(`SELECT to_id AS toId FROM video_redirects WHERE from_id = ?`);
      const videoExists = db.prepare(`SELECT 1 AS ok FROM videos WHERE id = ?`);
      for (let hop = 0; hop < 8; hop += 1) {
        const next = lookup.get(current) as { toId: string } | undefined;
        if (!next || !videoExists.get(next.toId)) return current;
        current = next.toId;
      }
      return current;
    },

    transaction(work: () => void): void {
      db.transaction(work)();
    },

    getVideo(id: string): VideoRecord | null {
      return (videoById.get(id) as VideoRecord | undefined) ?? null;
    },

    findVideosByPartialHash(hash: string, size: number): VideoRecord[] {
      return videosByHash.all(hash, size) as VideoRecord[];
    },

    locationsForVideo(videoId: string): LocationRecord[] {
      return locationsForVideoStmt.all(videoId) as LocationRecord[];
    },

    insertVideo(video: VideoWrite): void {
      insertVideoStmt.run(video);
    },

    /** Technical columns only. Title, notes, exclusion, and other user fields stay put. */
    updateVideoTechnical(video: VideoWrite): void {
      updateVideoStmt.run(video);
    },

    setFullHash(id: string, hash: string, kind: string, now: string): void {
      db.prepare(
        `UPDATE videos SET full_hash = ?, full_hash_kind = ?, updated_at = ? WHERE id = ?`,
      ).run(hash, kind, now, id);
    },

    insertLocation(location: LocationWrite): void {
      insertLocationStmt.run({ ...location, pathKey: pathKey(location.path) });
    },

    updateLocation(location: LocationWrite): void {
      updateLocationStmt.run({ ...location, pathKey: pathKey(location.path) });
    },

    noteError(videoId: string, message: string, now: string): void {
      db.prepare(`UPDATE videos SET metadata_error = ?, updated_at = ? WHERE id = ?`).run(
        message,
        now,
        videoId,
      );
    },

    markMissingIds(ids: readonly string[], now: string): number {
      const stmt = db.prepare(
        `UPDATE video_locations
         SET presence = 'missing', updated_at = ?
         WHERE id = ? AND presence = 'present'`,
      );
      const apply = db.transaction(() => {
        let changed = 0;
        for (const id of ids) changed += stmt.run(now, id).changes;
        return changed;
      });
      return apply();
    },

    /**
     * Drops content rows that have no locations and no user-entered fields.
     * Returns thumbnail file names so the caller can delete only those files.
     */
    deleteEmptyOrphans(): string[] {
      const rows = db
        .prepare(
          `SELECT id, thumbnail_file AS thumbnailFile FROM videos v
           WHERE excluded = 0
             AND title IS NULL AND notes IS NULL AND video_type IS NULL AND style_id IS NULL
             AND level IS NULL AND event_name IS NULL AND event_date IS NULL AND rating IS NULL
             AND favorite = 0
             AND NOT EXISTS (SELECT 1 FROM video_locations WHERE video_id = v.id)
             AND NOT EXISTS (SELECT 1 FROM video_tags WHERE video_id = v.id)
             AND NOT EXISTS (SELECT 1 FROM video_instructors WHERE video_id = v.id)
             AND NOT EXISTS (
               SELECT 1 FROM video_links WHERE video_id = v.id OR other_video_id = v.id
             )`,
        )
        .all() as { id: string; thumbnailFile: string | null }[];
      const remove = db.prepare(`DELETE FROM videos WHERE id = ?`);
      const prune = db.prepare(
        `DELETE FROM video_redirects WHERE to_id NOT IN (SELECT id FROM videos)`,
      );
      const apply = db.transaction(() => {
        for (const row of rows) remove.run(row.id);
        prune.run();
      });
      apply();
      return rows
        .map((row) => row.thumbnailFile)
        .filter((file): file is string => file != null && file.length > 0);
    },

    /**
     * Keep one content row. Locations and any filled-in user fields move with it.
     * Exclusion wins: a removed video stays removed after a duplicate is merged in.
     */
    mergeVideos(keepId: string, dropIds: readonly string[], now: string): void {
      const apply = db.transaction(() => {
        for (const dropId of [...new Set(dropIds)]) {
          if (dropId === keepId) continue;
          const dropHash = db
            .prepare(
              `SELECT full_hash AS fullHash, full_hash_kind AS fullHashKind FROM videos WHERE id = ?`,
            )
            .get(dropId) as { fullHash: string | null; fullHashKind: string | null } | undefined;
          db.prepare(`UPDATE videos SET full_hash = NULL, full_hash_kind = NULL WHERE id = ?`).run(
            dropId,
          );
          db.prepare(
            `UPDATE videos SET
               full_hash = COALESCE(full_hash, ?),
               full_hash_kind = COALESCE(full_hash_kind, ?)
             WHERE id = ?`,
          ).run(dropHash?.fullHash ?? null, dropHash?.fullHashKind ?? null, keepId);
          db.prepare(
            `UPDATE videos SET
               excluded_at = CASE
                 WHEN excluded = 0 AND (SELECT excluded FROM videos WHERE id = ?) = 1
                   THEN (SELECT excluded_at FROM videos WHERE id = ?)
                 WHEN excluded = 1 AND (SELECT excluded FROM videos WHERE id = ?) = 1
                   THEN MIN(excluded_at, (SELECT excluded_at FROM videos WHERE id = ?))
                 ELSE excluded_at
               END
             WHERE id = ?`,
          ).run(dropId, dropId, dropId, dropId, keepId);
          db.prepare(
            `UPDATE videos SET
               title = COALESCE(title, (SELECT title FROM videos WHERE id = ?)),
               video_type = COALESCE(video_type, (SELECT video_type FROM videos WHERE id = ?)),
               style_id = COALESCE(style_id, (SELECT style_id FROM videos WHERE id = ?)),
               level = COALESCE(level, (SELECT level FROM videos WHERE id = ?)),
               event_name = COALESCE(event_name, (SELECT event_name FROM videos WHERE id = ?)),
               event_date = COALESCE(event_date, (SELECT event_date FROM videos WHERE id = ?)),
               rating = COALESCE(rating, (SELECT rating FROM videos WHERE id = ?)),
               notes = COALESCE(notes, (SELECT notes FROM videos WHERE id = ?)),
               favorite = MAX(favorite, (SELECT favorite FROM videos WHERE id = ?)),
               excluded = MAX(excluded, (SELECT excluded FROM videos WHERE id = ?)),
               thumbnail_file = COALESCE(thumbnail_file, (SELECT thumbnail_file FROM videos WHERE id = ?)),
               content_hash = COALESCE(content_hash, (SELECT content_hash FROM videos WHERE id = ?)),
               content_hash_kind = COALESCE(content_hash_kind, (SELECT content_hash_kind FROM videos WHERE id = ?)),
               updated_at = ?
             WHERE id = ?`,
          ).run(
            dropId,
            dropId,
            dropId,
            dropId,
            dropId,
            dropId,
            dropId,
            dropId,
            dropId,
            dropId,
            dropId,
            dropId,
            dropId,
            now,
            keepId,
          );
          db.prepare(`UPDATE video_locations SET video_id = ? WHERE video_id = ?`).run(
            keepId,
            dropId,
          );
          db.prepare(
            `INSERT OR IGNORE INTO video_instructors (video_id, instructor_id)
             SELECT ?, instructor_id FROM video_instructors WHERE video_id = ?`,
          ).run(keepId, dropId);
          db.prepare(
            `INSERT OR IGNORE INTO video_tags (video_id, tag_id)
             SELECT ?, tag_id FROM video_tags WHERE video_id = ?`,
          ).run(keepId, dropId);
          db.prepare(
            `INSERT OR IGNORE INTO video_links (id, video_id, other_video_id, kind, created_at)
             SELECT
               lower(hex(randomblob(16))),
               CASE WHEN video_id = ? THEN ? ELSE video_id END,
               CASE WHEN other_video_id = ? THEN ? ELSE other_video_id END,
               kind,
               created_at
             FROM video_links
             WHERE (video_id = ? OR other_video_id = ?)
               AND CASE WHEN video_id = ? THEN ? ELSE video_id END
                   <> CASE WHEN other_video_id = ? THEN ? ELSE other_video_id END`,
          ).run(dropId, keepId, dropId, keepId, dropId, dropId, dropId, keepId, dropId, keepId);
          db.prepare(`UPDATE video_redirects SET to_id = ? WHERE to_id = ?`).run(keepId, dropId);
          db.prepare(
            `INSERT INTO video_redirects (from_id, to_id) VALUES (?, ?)
             ON CONFLICT(from_id) DO UPDATE SET to_id = excluded.to_id`,
          ).run(dropId, keepId);
          db.prepare(`DELETE FROM videos WHERE id = ?`).run(dropId);
        }
      });
      apply();
    },

    listLibrarySummaries(): LibrarySummary[] {
      return db
        .prepare(
          `SELECT
             l.id, l.path, l.label, l.availability,
             l.last_scanned_at AS lastScannedAt, l.last_error AS lastError,
             (
               SELECT COUNT(DISTINCT loc.video_id)
               FROM video_locations loc
               JOIN videos v ON v.id = loc.video_id
               WHERE loc.library_id = l.id AND v.excluded = 0
             ) AS videoCount,
             (
               SELECT COUNT(DISTINCT loc.video_id)
               FROM video_locations loc
               JOIN videos v ON v.id = loc.video_id
               WHERE loc.library_id = l.id AND v.excluded = 0 AND loc.presence = 'missing'
                 AND NOT EXISTS (
                   SELECT 1 FROM video_locations other
                   WHERE other.video_id = loc.video_id
                     AND other.library_id = l.id
                     AND other.presence = 'present'
                 )
             ) AS missingCount
           FROM libraries l
           ORDER BY l.label COLLATE NOCASE, l.path`,
        )
        .all() as LibrarySummary[];
    },

    countVideos(): { visible: number; excluded: number } {
      const row = db
        .prepare(
          `SELECT
             SUM(CASE WHEN excluded = 0 THEN 1 ELSE 0 END) AS visible,
             SUM(CASE WHEN excluded = 1 THEN 1 ELSE 0 END) AS excluded
           FROM videos`,
        )
        .get() as { visible: number | null; excluded: number | null };
      return { visible: row.visible ?? 0, excluded: row.excluded ?? 0 };
    },

    listVideoSummaries(query: VideoQuery = {}): VideoListItem[] {
      const { sql, params } = videoListQuery(query);
      const rows = db.prepare(sql).all(params) as RawVideoRow[];
      return rows.map(toListItem);
    },

    countVideoSummaries(query: VideoQuery = {}): number {
      const { countSql, params } = videoListQuery({
        ...query,
        limit: undefined,
        offset: undefined,
      });
      const row = db.prepare(countSql).get(params) as { total: number };
      return row.total;
    },

    listFacets(excluded = false): CatalogFacets {
      const flag = excluded ? 1 : 0;
      return {
        styles: db
          .prepare(
            `SELECT DISTINCT s.id, s.name
             FROM styles s
             JOIN videos v ON v.style_id = s.id
             WHERE v.excluded = ?
             ORDER BY s.name COLLATE NOCASE`,
          )
          .all(flag) as CatalogFacets['styles'],
        instructors: db
          .prepare(
            `SELECT DISTINCT i.id, i.name
             FROM instructors i
             JOIN video_instructors vi ON vi.instructor_id = i.id
             JOIN videos v ON v.id = vi.video_id
             WHERE v.excluded = ?
             ORDER BY i.name COLLATE NOCASE`,
          )
          .all(flag) as CatalogFacets['instructors'],
        tags: db
          .prepare(
            `SELECT DISTINCT t.id, t.name
             FROM tags t
             JOIN video_tags vt ON vt.tag_id = t.id
             JOIN videos v ON v.id = vt.video_id
             WHERE v.excluded = ?
             ORDER BY t.name COLLATE NOCASE`,
          )
          .all(flag) as CatalogFacets['tags'],
        libraries: db
          .prepare(
            `SELECT DISTINCT lib.id, lib.label
             FROM libraries lib
             JOIN video_locations loc ON loc.library_id = lib.id
             JOIN videos v ON v.id = loc.video_id
             WHERE v.excluded = ?
             ORDER BY lib.label COLLATE NOCASE`,
          )
          .all(flag) as CatalogFacets['libraries'],
      };
    },

    excludeVideos(ids: readonly string[], now: string): number {
      const stmt = db.prepare(
        `UPDATE videos SET excluded = 1, excluded_at = ?, updated_at = ? WHERE id = ? AND excluded = 0`,
      );
      const apply = db.transaction(() => {
        let changed = 0;
        for (const id of ids) changed += stmt.run(now, now, this.resolveVideoId(id)).changes;
        return changed;
      });
      return apply();
    },

    restoreVideos(ids: readonly string[], now: string): number {
      const stmt = db.prepare(
        `UPDATE videos SET excluded = 0, excluded_at = NULL, updated_at = ? WHERE id = ? AND excluded = 1`,
      );
      const apply = db.transaction(() => {
        let changed = 0;
        for (const id of ids) changed += stmt.run(now, this.resolveVideoId(id)).changes;
        return changed;
      });
      return apply();
    },

    removeLibrary(id: string): boolean {
      const result = db.prepare(`DELETE FROM libraries WHERE id = ?`).run(id);
      return result.changes > 0;
    },
  };
}

function takeLocationSample(
  db: Database.Database,
  libraryId: string,
  limit: number,
  presence: 'present' | null,
): LocationRecord[] {
  const presenceSql = presence ? `AND presence = '${presence}'` : '';
  return db
    .prepare(
      `${LOCATION_SELECT}
       WHERE library_id = ? ${presenceSql}
       ORDER BY last_scan_generation DESC, updated_at DESC, id DESC
       LIMIT ?`,
    )
    .all(libraryId, limit) as LocationRecord[];
}

export type CatalogRepository = ReturnType<typeof createRepository>;

type RawVideoRow = {
  id: string;
  title: string | null;
  sizeBytes: number | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  capturedAt: string | null;
  capturedAtSource: CaptureDateSource | null;
  metadataError: string | null;
  thumbnailFile: string | null;
  excluded: number;
  videoType: VideoType | null;
  level: Level | null;
  favorite: number;
  styleName: string | null;
  displayTitle: string;
  instructorsJson: string;
  tagsJson: string;
  locationsJson: string;
};

function toListItem(row: RawVideoRow): VideoListItem {
  const parsed = JSON.parse(row.locationsJson) as (VideoLocationItem | null)[];
  const locations = parsed.filter((location): location is VideoLocationItem => location !== null);
  locations.sort((left, right) => {
    if (left.presence !== right.presence) return left.presence === 'present' ? -1 : 1;
    return left.filename.localeCompare(right.filename);
  });
  const title = row.title?.trim() ? row.title.trim() : null;
  return {
    id: row.id,
    title,
    displayTitle: row.displayTitle.trim() ? row.displayTitle.trim() : (title ?? 'Untitled'),
    sizeBytes: row.sizeBytes,
    durationMs: row.durationMs,
    width: row.width,
    height: row.height,
    videoCodec: row.videoCodec,
    capturedAt: row.capturedAt,
    capturedAtSource: row.capturedAtSource,
    presence: locations.some((location) => location.presence === 'present') ? 'present' : 'missing',
    metadataError: row.metadataError,
    thumbnailUrl: thumbnailUrl(row.thumbnailFile),
    excluded: row.excluded === 1,
    videoType: row.videoType,
    styleName: row.styleName,
    level: row.level,
    favorite: row.favorite === 1,
    instructors: names(row.instructorsJson),
    tags: names(row.tagsJson),
    locations,
  };
}

function names(json: string): string[] {
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
}
