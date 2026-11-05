import type { Migration } from '../migrate';

/**
 * Catalog shape for the whole v1 plan. Phase 1 fills technical columns only.
 * User fields, styles, instructors, tags, and lesson/demo links stay empty
 * until later phases so those phases do not have to rewrite video rows.
 *
 * The catalog stores references and metadata only. This migration does not
 * touch video files.
 */
export const migration002: Migration = {
  id: 2,
  name: '002_catalog',
  up(db) {
    db.exec(`
      CREATE TABLE libraries (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        volume_id TEXT,
        volume_rel_path TEXT,
        label TEXT NOT NULL,
        availability TEXT NOT NULL DEFAULT 'online' CHECK (availability IN ('online', 'offline')),
        source_kind TEXT NOT NULL DEFAULT 'folder' CHECK (source_kind IN ('folder', 'takeout')),
        scan_generation INTEGER NOT NULL DEFAULT 0,
        last_scanned_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE styles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE,
        builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX styles_name ON styles (name COLLATE NOCASE);

      CREATE TABLE instructors (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX instructors_name ON instructors (name COLLATE NOCASE);

      CREATE TABLE tags (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX tags_name ON tags (name COLLATE NOCASE);

      CREATE TABLE videos (
        id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL REFERENCES libraries (id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        filename TEXT NOT NULL,
        volume_id TEXT,
        file_id TEXT,
        content_hash TEXT,
        content_hash_kind TEXT,
        size_bytes INTEGER,
        mtime_ns TEXT,
        duration_ms INTEGER,
        width INTEGER,
        height INTEGER,
        video_codec TEXT,
        container TEXT,
        captured_at TEXT,
        captured_at_source TEXT CHECK (
          captured_at_source IN ('metadata', 'filename', 'file_time') OR captured_at_source IS NULL
        ),
        metadata_created_at TEXT,
        file_created_at TEXT,
        file_modified_at TEXT,
        title TEXT,
        video_type TEXT CHECK (
          video_type IN ('lesson', 'demo', 'social dance', 'performance') OR video_type IS NULL
        ),
        style_id TEXT REFERENCES styles (id) ON DELETE SET NULL,
        level TEXT CHECK (
          level IN ('Beginner', 'Intermediate', 'Advanced', 'Master', 'All levels') OR level IS NULL
        ),
        event_name TEXT,
        event_date TEXT,
        rating INTEGER CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5)),
        favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
        notes TEXT,
        presence TEXT NOT NULL DEFAULT 'present' CHECK (presence IN ('present', 'missing')),
        source_kind TEXT NOT NULL DEFAULT 'folder' CHECK (source_kind IN ('folder', 'takeout')),
        last_scan_generation INTEGER NOT NULL DEFAULT 0,
        metadata_error TEXT,
        thumbnail_file TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX videos_path ON videos (path);
      CREATE INDEX videos_library ON videos (library_id);
      CREATE INDEX videos_identity ON videos (volume_id, file_id);
      CREATE INDEX videos_hash ON videos (content_hash, size_bytes);
      CREATE INDEX videos_presence ON videos (presence);

      CREATE TABLE video_instructors (
        video_id TEXT NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
        instructor_id TEXT NOT NULL REFERENCES instructors (id) ON DELETE CASCADE,
        PRIMARY KEY (video_id, instructor_id)
      );

      CREATE TABLE video_tags (
        video_id TEXT NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
        tag_id TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
        PRIMARY KEY (video_id, tag_id)
      );

      CREATE TABLE video_links (
        id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
        other_video_id TEXT NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('lesson_demo')),
        created_at TEXT NOT NULL,
        CHECK (video_id <> other_video_id)
      );
      CREATE UNIQUE INDEX video_links_pair ON video_links (video_id, other_video_id, kind);
    `);
  },
};
