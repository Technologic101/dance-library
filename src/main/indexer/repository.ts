import type Database from 'better-sqlite3';
import {
  thumbnailUrl,
  type CaptureDateSource,
  type LibrarySummary,
  type VideoListItem,
  type VideoLocationItem,
} from '../../shared/api';

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
  const locationByPath = db.prepare(`${LOCATION_SELECT} WHERE path = ?`);
  const locationByPathNoCase = db.prepare(`${LOCATION_SELECT} WHERE path = ? COLLATE NOCASE`);
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
      id, video_id, library_id, path, filename, volume_id, file_id, size_bytes, mtime_ns,
      file_created_at, file_modified_at, presence, last_scan_generation, created_at, updated_at
    ) VALUES (
      @id, @videoId, @libraryId, @path, @filename, @volumeId, @fileId, @sizeBytes, @mtimeNs,
      @fileCreatedAt, @fileModifiedAt, 'present', @generation, @now, @now
    )
  `);
  const updateLocationStmt = db.prepare(`
    UPDATE video_locations SET
      video_id = @videoId,
      library_id = @libraryId,
      path = @path,
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
      const stmt = process.platform === 'win32' ? locationByPathNoCase : locationByPath;
      return (stmt.get(filePath) as LocationRecord | undefined) ?? null;
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
      insertLocationStmt.run(location);
    },

    updateLocation(location: LocationWrite): void {
      updateLocationStmt.run(location);
    },

    noteError(videoId: string, message: string, now: string): void {
      db.prepare(`UPDATE videos SET metadata_error = ?, updated_at = ? WHERE id = ?`).run(
        message,
        now,
        videoId,
      );
    },

    markMissing(libraryId: string, generation: number, now: string): number {
      const result = db
        .prepare(
          `UPDATE video_locations
           SET presence = 'missing', updated_at = ?
           WHERE library_id = ? AND last_scan_generation < ? AND presence = 'present'`,
        )
        .run(now, libraryId, generation);
      return result.changes;
    },

    /**
     * Keep one content row. Locations and any filled-in user fields move with it.
     * Exclusion wins: a removed video stays removed after a duplicate is merged in.
     */
    mergeVideos(keepId: string, dropIds: readonly string[], now: string): void {
      const apply = db.transaction(() => {
        for (const dropId of dropIds) {
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

    listVideoSummaries(excluded: boolean): VideoListItem[] {
      const rows = db
        .prepare(
          `SELECT
             v.id, v.title, v.size_bytes AS sizeBytes, v.duration_ms AS durationMs,
             v.width, v.height, v.video_codec AS videoCodec, v.captured_at AS capturedAt,
             v.captured_at_source AS capturedAtSource, v.metadata_error AS metadataError,
             v.thumbnail_file AS thumbnailFile, v.excluded,
             json_group_array(
               CASE WHEN loc.id IS NULL THEN NULL ELSE json_object(
                 'id', loc.id,
                 'libraryId', loc.library_id,
                 'libraryLabel', lib.label,
                 'path', loc.path,
                 'filename', loc.filename,
                 'presence', loc.presence
               ) END
             ) AS locationsJson
           FROM videos v
           LEFT JOIN video_locations loc ON loc.video_id = v.id
           LEFT JOIN libraries lib ON lib.id = loc.library_id
           WHERE v.excluded = ?
           GROUP BY v.id
           ORDER BY COALESCE(NULLIF(TRIM(v.title), ''), v.created_at)`,
        )
        .all(excluded ? 1 : 0) as RawVideoRow[];
      return rows.map(toListItem);
    },

    excludeVideos(ids: readonly string[], now: string): number {
      const stmt = db.prepare(
        `UPDATE videos SET excluded = 1, excluded_at = ?, updated_at = ? WHERE id = ? AND excluded = 0`,
      );
      const apply = db.transaction(() => {
        let changed = 0;
        for (const id of ids) changed += stmt.run(now, now, id).changes;
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
        for (const id of ids) changed += stmt.run(now, id).changes;
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
  locationsJson: string;
};

function toListItem(row: RawVideoRow): VideoListItem {
  const parsed = JSON.parse(row.locationsJson) as (VideoLocationItem | null)[];
  const locations = parsed.filter((location): location is VideoLocationItem => location !== null);
  locations.sort((left, right) => {
    if (left.presence !== right.presence) return left.presence === 'present' ? -1 : 1;
    return left.filename.localeCompare(right.filename);
  });
  const primary = locations[0];
  const title = row.title?.trim() ? row.title.trim() : null;
  return {
    id: row.id,
    title,
    displayTitle: title ?? primary?.filename ?? 'Untitled',
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
    locations,
  };
}
