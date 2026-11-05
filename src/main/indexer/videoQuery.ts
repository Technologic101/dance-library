import type { VideoQuery, VideoSort } from '../../shared/api';
import { ftsMatch } from '../../shared/search';

export function videoListQuery(query: VideoQuery): {
  sql: string;
  params: Record<string, string | number>;
} {
  const params: Record<string, string | number> = {
    excluded: query.excluded ? 1 : 0,
  };
  const where = ['v.excluded = @excluded'];
  const match = query.text ? ftsMatch(query.text) : null;
  let ftsJoin = '';
  if (match === '') {
    where.push('0');
  } else if (match) {
    params.match = match;
    ftsJoin = `
      JOIN (
        SELECT video_id, bm25(videos_fts) AS rank
        FROM videos_fts
        WHERE videos_fts MATCH @match
        LIMIT -1
      ) fts ON fts.video_id = v.id
    `;
  }
  if (query.capturedFrom) {
    params.capturedFrom = query.capturedFrom;
    where.push(`substr(v.captured_at, 1, 10) >= @capturedFrom`);
  }
  if (query.capturedTo) {
    params.capturedTo = query.capturedTo;
    where.push(`substr(v.captured_at, 1, 10) <= @capturedTo`);
  }
  addIn(where, params, 'v.video_type', query.videoTypes, 'type');
  addIn(where, params, 'v.style_id', query.styleIds, 'style');
  addIn(where, params, 'v.level', query.levels, 'level');
  addExists(
    where,
    params,
    query.instructorIds,
    'instructor',
    `SELECT 1 FROM video_instructors vi
     WHERE vi.video_id = v.id AND vi.instructor_id IN ({ids})`,
  );
  addExists(
    where,
    params,
    query.libraryIds,
    'library',
    `SELECT 1 FROM video_locations src
     WHERE src.video_id = v.id AND src.library_id IN ({ids})`,
  );
  for (const [index, tagId] of (query.tagIds ?? []).entries()) {
    const key = `tag${index}`;
    params[key] = tagId;
    where.push(
      `EXISTS (SELECT 1 FROM video_tags vt WHERE vt.video_id = v.id AND vt.tag_id = @${key})`,
    );
  }
  if (query.favorite) where.push('v.favorite = 1');
  if (query.durationMinMs != null) {
    params.durationMin = query.durationMinMs;
    where.push('v.duration_ms >= @durationMin');
  }
  if (query.durationMaxMs != null) {
    params.durationMax = query.durationMaxMs;
    where.push('v.duration_ms <= @durationMax');
  }

  const sql = `
    SELECT
      v.id,
      v.title,
      v.size_bytes AS sizeBytes,
      v.duration_ms AS durationMs,
      v.width,
      v.height,
      v.video_codec AS videoCodec,
      v.captured_at AS capturedAt,
      v.captured_at_source AS capturedAtSource,
      v.metadata_error AS metadataError,
      v.thumbnail_file AS thumbnailFile,
      v.excluded,
      v.video_type AS videoType,
      v.level,
      v.favorite,
      MAX(s.name) AS styleName,
      COALESCE(NULLIF(TRIM(v.title), ''), MIN(loc.filename), '') AS displayTitle,
      COALESCE((
        SELECT json_group_array(name) FROM (
          SELECT i.name AS name
          FROM video_instructors vi
          JOIN instructors i ON i.id = vi.instructor_id
          WHERE vi.video_id = v.id
          ORDER BY i.name COLLATE NOCASE
        )
      ), '[]') AS instructorsJson,
      COALESCE((
        SELECT json_group_array(name) FROM (
          SELECT t.name AS name
          FROM video_tags vt
          JOIN tags t ON t.id = vt.tag_id
          WHERE vt.video_id = v.id
          ORDER BY t.name COLLATE NOCASE
        )
      ), '[]') AS tagsJson,
      ${match ? 'MIN(fts.rank)' : 'NULL'} AS rank,
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
    LEFT JOIN styles s ON s.id = v.style_id
    ${ftsJoin}
    WHERE ${where.join(' AND ')}
    GROUP BY v.id
    ORDER BY ${orderBy(query.sort, Boolean(match))}
  `;
  return { sql, params };
}

function addIn(
  where: string[],
  params: Record<string, string | number>,
  column: string,
  values: readonly string[] | undefined,
  prefix: string,
): void {
  if (!values || values.length === 0) return;
  const names = values.map((value, index) => {
    const key = `${prefix}${index}`;
    params[key] = value;
    return `@${key}`;
  });
  where.push(`${column} IN (${names.join(', ')})`);
}

function addExists(
  where: string[],
  params: Record<string, string | number>,
  values: readonly string[] | undefined,
  prefix: string,
  sql: string,
): void {
  if (!values || values.length === 0) return;
  const names = values.map((value, index) => {
    const key = `${prefix}${index}`;
    params[key] = value;
    return `@${key}`;
  });
  where.push(`EXISTS (${sql.replace('{ids}', names.join(', '))})`);
}

function orderBy(sort: VideoSort | undefined, hasText: boolean): string {
  switch (sort) {
    case 'oldest':
      return 'CASE WHEN v.captured_at IS NULL THEN 1 ELSE 0 END, v.captured_at ASC, v.id ASC';
    case 'title':
      return 'displayTitle COLLATE NOCASE ASC, v.id ASC';
    case 'title-desc':
      return 'displayTitle COLLATE NOCASE DESC, v.id ASC';
    case 'longest':
      return 'CASE WHEN v.duration_ms IS NULL THEN 1 ELSE 0 END, v.duration_ms DESC, v.id ASC';
    case 'shortest':
      return 'CASE WHEN v.duration_ms IS NULL THEN 1 ELSE 0 END, v.duration_ms ASC, v.id ASC';
    case 'relevance':
      return hasText
        ? 'rank ASC, v.id ASC'
        : 'CASE WHEN v.captured_at IS NULL THEN 1 ELSE 0 END, v.captured_at DESC, v.id ASC';
    case 'newest':
    default:
      return 'CASE WHEN v.captured_at IS NULL THEN 1 ELSE 0 END, v.captured_at DESC, v.id ASC';
  }
}
