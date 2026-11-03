import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  thumbnailUrl,
  type CaptureDateSource,
  type LibrarySummary,
  type VideoListItem,
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

export type VideoIdentity = {
  id: string;
  libraryId: string;
  path: string;
  filename: string;
  volumeId: string | null;
  fileId: string | null;
  contentHash: string | null;
  sizeBytes: number | null;
  mtimeNs: string | null;
  durationMs: number | null;
  width: number | null;
  videoCodec: string | null;
  capturedAt: string | null;
  capturedAtSource: CaptureDateSource | null;
  presence: 'present' | 'missing';
  metadataError: string | null;
  thumbnailFile: string | null;
};

export type TechnicalVideo = {
  id: string;
  libraryId: string;
  path: string;
  filename: string;
  volumeId: string | null;
  fileId: string | null;
  contentHash: string | null;
  contentHashKind: string | null;
  sizeBytes: number | null;
  mtimeNs: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  container: string | null;
  capturedAt: string | null;
  capturedAtSource: CaptureDateSource | null;
  metadataCreatedAt: string | null;
  fileCreatedAt: string | null;
  fileModifiedAt: string | null;
  metadataError: string | null;
  thumbnailFile: string | null;
  generation: number;
  now: string;
};

const VIDEO_SELECT = `
  SELECT
    id,
    library_id AS libraryId,
    path,
    filename,
    volume_id AS volumeId,
    file_id AS fileId,
    content_hash AS contentHash,
    size_bytes AS sizeBytes,
    mtime_ns AS mtimeNs,
    duration_ms AS durationMs,
    width,
    video_codec AS videoCodec,
    captured_at AS capturedAt,
    captured_at_source AS capturedAtSource,
    presence,
    metadata_error AS metadataError,
    thumbnail_file AS thumbnailFile
  FROM videos
`;

const LIBRARY_SELECT = `
  SELECT
    id,
    path,
    volume_id AS volumeId,
    volume_rel_path AS volumeRelPath,
    label,
    availability,
    scan_generation AS scanGeneration,
    last_scanned_at AS lastScannedAt,
    last_error AS lastError
  FROM libraries
`;

export function createRepository(db: Database.Database) {
  const libraryById = db.prepare(`${LIBRARY_SELECT} WHERE id = ?`);
  const libraries = db.prepare(`${LIBRARY_SELECT} ORDER BY label COLLATE NOCASE, path`);
  const insertLibraryStmt = db.prepare(`
    INSERT INTO libraries (id, path, label, availability, created_at, updated_at)
    VALUES (@id, @path, @label, 'online', @now, @now)
  `);
  const videosByIdentity = db.prepare(
    `${VIDEO_SELECT} WHERE volume_id = ? AND file_id = ? ORDER BY created_at, id`,
  );
  const videoByPath = db.prepare(`${VIDEO_SELECT} WHERE path = ?`);
  const videoByPathNoCase = db.prepare(`${VIDEO_SELECT} WHERE path = ? COLLATE NOCASE`);
  const videosByHash = db.prepare(
    `${VIDEO_SELECT} WHERE content_hash = ? AND size_bytes = ? ORDER BY created_at, id`,
  );

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

    findByIdentity(volumeId: string, fileId: string): VideoIdentity[] {
      return videosByIdentity.all(volumeId, fileId) as VideoIdentity[];
    },

    findByPath(filePath: string): VideoIdentity | null {
      const stmt = process.platform === 'win32' ? videoByPathNoCase : videoByPath;
      return (stmt.get(filePath) as VideoIdentity | undefined) ?? null;
    },

    findByHash(hash: string, size: number): VideoIdentity[] {
      return videosByHash.all(hash, size) as VideoIdentity[];
    },

    insertVideo(video: TechnicalVideo): void {
      db.prepare(
        `INSERT INTO videos (
           id, library_id, path, filename, volume_id, file_id, content_hash, content_hash_kind,
           size_bytes, mtime_ns, duration_ms, width, height, video_codec, container,
           captured_at, captured_at_source, metadata_created_at, file_created_at, file_modified_at,
           presence, last_scan_generation, metadata_error, thumbnail_file, created_at, updated_at
         ) VALUES (
           @id, @libraryId, @path, @filename, @volumeId, @fileId, @contentHash, @contentHashKind,
           @sizeBytes, @mtimeNs, @durationMs, @width, @height, @videoCodec, @container,
           @capturedAt, @capturedAtSource, @metadataCreatedAt, @fileCreatedAt, @fileModifiedAt,
           'present', @generation, @metadataError, @thumbnailFile, @now, @now
         )`,
      ).run(video);
    },

    /** Updates technical columns only. User catalog fields are left alone. */
    updateTechnical(video: TechnicalVideo): void {
      db.prepare(
        `UPDATE videos SET
           library_id = @libraryId,
           path = @path,
           filename = @filename,
           volume_id = @volumeId,
           file_id = @fileId,
           content_hash = @contentHash,
           content_hash_kind = @contentHashKind,
           size_bytes = @sizeBytes,
           mtime_ns = @mtimeNs,
           duration_ms = @durationMs,
           width = @width,
           height = @height,
           video_codec = @videoCodec,
           container = @container,
           captured_at = @capturedAt,
           captured_at_source = @capturedAtSource,
           metadata_created_at = @metadataCreatedAt,
           file_created_at = @fileCreatedAt,
           file_modified_at = @fileModifiedAt,
           presence = 'present',
           last_scan_generation = @generation,
           metadata_error = @metadataError,
           thumbnail_file = @thumbnailFile,
           updated_at = @now
         WHERE id = @id`,
      ).run(video);
    },

    touchVideo(input: {
      id: string;
      libraryId: string;
      path: string;
      filename: string;
      volumeId: string | null;
      fileId: string | null;
      capturedAt: string | null;
      capturedAtSource: CaptureDateSource | null;
      generation: number;
      now: string;
    }): void {
      db.prepare(
        `UPDATE videos SET
           library_id = @libraryId,
           path = @path,
           filename = @filename,
           volume_id = @volumeId,
           file_id = @fileId,
           captured_at = @capturedAt,
           captured_at_source = @capturedAtSource,
           presence = 'present',
           last_scan_generation = @generation,
           updated_at = @now
         WHERE id = @id`,
      ).run(input);
    },

    noteError(id: string, message: string, generation: number, now: string): void {
      db.prepare(
        `UPDATE videos SET
           metadata_error = ?,
           presence = 'present',
           last_scan_generation = ?,
           updated_at = ?
         WHERE id = ?`,
      ).run(message, generation, now, id);
    },

    markMissing(libraryId: string, generation: number, now: string): number {
      const result = db
        .prepare(
          `UPDATE videos
           SET presence = 'missing', updated_at = ?
           WHERE library_id = ? AND last_scan_generation < ? AND presence = 'present'`,
        )
        .run(now, libraryId, generation);
      return result.changes;
    },

    listLibrarySummaries(): LibrarySummary[] {
      const rows = db
        .prepare(
          `SELECT
             l.id,
             l.path,
             l.label,
             l.availability,
             l.last_scanned_at AS lastScannedAt,
             l.last_error AS lastError,
             (SELECT COUNT(*) FROM videos v WHERE v.library_id = l.id) AS videoCount,
             (SELECT COUNT(*) FROM videos v WHERE v.library_id = l.id AND v.presence = 'missing') AS missingCount
           FROM libraries l
           ORDER BY l.label COLLATE NOCASE, l.path`,
        )
        .all() as LibrarySummary[];
      return rows;
    },

    listVideoSummaries(): VideoListItem[] {
      const rows = db
        .prepare(
          `SELECT
             v.id,
             v.library_id AS libraryId,
             l.label AS libraryLabel,
             v.path,
             v.filename,
             v.title,
             v.size_bytes AS sizeBytes,
             v.duration_ms AS durationMs,
             v.width,
             v.height,
             v.video_codec AS videoCodec,
             v.captured_at AS capturedAt,
             v.captured_at_source AS capturedAtSource,
             v.presence,
             v.metadata_error AS metadataError,
             v.thumbnail_file AS thumbnailFile
           FROM videos v
           JOIN libraries l ON l.id = v.library_id
           ORDER BY v.filename COLLATE NOCASE, v.path`,
        )
        .all() as (Omit<VideoListItem, 'displayTitle' | 'thumbnailUrl'> & {
        thumbnailFile: string | null;
      })[];
      return rows.map((row) => ({
        id: row.id,
        libraryId: row.libraryId,
        libraryLabel: row.libraryLabel,
        path: row.path,
        filename: row.filename,
        title: row.title,
        displayTitle: row.title?.trim() ? row.title.trim() : row.filename,
        sizeBytes: row.sizeBytes,
        durationMs: row.durationMs,
        width: row.width,
        height: row.height,
        videoCodec: row.videoCodec,
        capturedAt: row.capturedAt,
        capturedAtSource: row.capturedAtSource,
        presence: row.presence,
        metadataError: row.metadataError,
        thumbnailUrl: thumbnailUrl(row.thumbnailFile),
      }));
    },

    removeLibrary(id: string, thumbsDir: string): boolean {
      const thumbs = db
        .prepare(`SELECT thumbnail_file AS thumbnailFile FROM videos WHERE library_id = ?`)
        .all(id) as { thumbnailFile: string | null }[];
      const result = db.prepare(`DELETE FROM libraries WHERE id = ?`).run(id);
      if (result.changes === 0) return false;
      for (const thumb of thumbs) {
        if (!thumb.thumbnailFile || path.basename(thumb.thumbnailFile) !== thumb.thumbnailFile)
          continue;
        fs.rmSync(path.join(thumbsDir, thumb.thumbnailFile), { force: true });
      }
      return true;
    },
  };
}

export type CatalogRepository = ReturnType<typeof createRepository>;
