import type { Migration } from '../migrate';

/**
 * A video is the content, not a path. File paths, volume ids, and inodes live
 * on video_locations. User metadata stays on videos. Exclusion hides a video
 * from the library without deleting any location row or any file.
 */
export const migration003: Migration = {
  id: 3,
  name: '003_content_identity',
  up(db) {
    db.exec(`
      CREATE TABLE videos_next (
        id TEXT PRIMARY KEY,
        content_hash TEXT,
        content_hash_kind TEXT,
        full_hash TEXT,
        full_hash_kind TEXT,
        size_bytes INTEGER,
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
        excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
        excluded_at TEXT,
        metadata_error TEXT,
        thumbnail_file TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO videos_next (
        id, content_hash, content_hash_kind, size_bytes, duration_ms, width, height,
        video_codec, container, captured_at, captured_at_source, metadata_created_at,
        title, video_type, style_id, level, event_name, event_date, rating, favorite, notes,
        metadata_error, thumbnail_file, created_at, updated_at
      )
      SELECT
        id, content_hash, content_hash_kind, size_bytes, duration_ms, width, height,
        video_codec, container, captured_at, captured_at_source, metadata_created_at,
        title, video_type, style_id, level, event_name, event_date, rating, favorite, notes,
        metadata_error, thumbnail_file, created_at, updated_at
      FROM videos;

      CREATE TABLE location_import (
        video_id TEXT NOT NULL,
        library_id TEXT NOT NULL,
        path TEXT NOT NULL,
        filename TEXT NOT NULL,
        volume_id TEXT,
        file_id TEXT,
        size_bytes INTEGER,
        mtime_ns TEXT,
        file_created_at TEXT,
        file_modified_at TEXT,
        presence TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        last_scan_generation INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO location_import (
        video_id, library_id, path, filename, volume_id, file_id, size_bytes, mtime_ns,
        file_created_at, file_modified_at, presence, source_kind, last_scan_generation,
        created_at, updated_at
      )
      SELECT
        id, library_id, path, filename, volume_id, file_id, size_bytes, mtime_ns,
        file_created_at, file_modified_at, presence, source_kind, last_scan_generation,
        created_at, updated_at
      FROM videos;

      DROP TABLE video_instructors;
      DROP TABLE video_tags;
      DROP TABLE video_links;
      DROP TABLE videos;

      ALTER TABLE videos_next RENAME TO videos;
      CREATE INDEX videos_hash ON videos (content_hash, size_bytes);
      CREATE UNIQUE INDEX videos_full_hash ON videos (full_hash) WHERE full_hash IS NOT NULL;
      CREATE INDEX videos_excluded ON videos (excluded);

      CREATE TABLE video_locations (
        id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
        library_id TEXT NOT NULL REFERENCES libraries (id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        filename TEXT NOT NULL,
        volume_id TEXT,
        file_id TEXT,
        size_bytes INTEGER,
        mtime_ns TEXT,
        file_created_at TEXT,
        file_modified_at TEXT,
        presence TEXT NOT NULL DEFAULT 'present' CHECK (presence IN ('present', 'missing')),
        source_kind TEXT NOT NULL DEFAULT 'folder' CHECK (source_kind IN ('folder', 'takeout')),
        last_scan_generation INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO video_locations (
        id, video_id, library_id, path, filename, volume_id, file_id, size_bytes, mtime_ns,
        file_created_at, file_modified_at, presence, source_kind, last_scan_generation,
        created_at, updated_at
      )
      SELECT
        video_id, video_id, library_id, path, filename, volume_id, file_id, size_bytes, mtime_ns,
        file_created_at, file_modified_at, presence, source_kind, last_scan_generation,
        created_at, updated_at
      FROM location_import;

      DROP TABLE location_import;

      CREATE UNIQUE INDEX video_locations_path ON video_locations (path);
      CREATE INDEX video_locations_video ON video_locations (video_id);
      CREATE INDEX video_locations_identity ON video_locations (volume_id, file_id);
      CREATE INDEX video_locations_library ON video_locations (library_id);

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
