import type { VideoQuery, VideoSort } from '../../shared/api';
import { ftsMatch } from '../../shared/search';

export function videoListQuery(query: VideoQuery): {
  sql: string;
  countSql: string;
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
      JOIN video_search_keys sk ON sk.video_id = v.id
      JOIN (
        SELECT rowid AS docId, bm25(videos_fts) AS rank
        FROM videos_fts
        WHERE videos_fts MATCH @match
        LIMIT -1
      ) fts ON fts.docId = sk.rowid
    `;
  }
  if (query.capturedFrom || query.capturedTo || query.capturedFromDay || query.capturedToDay) {
    if (query.capturedFrom) params.capturedFrom = query.capturedFrom;
    if (query.capturedTo) params.capturedTo = query.capturedTo;
    if (query.capturedFromDay) params.capturedFromDay = query.capturedFromDay;
    if (query.capturedToDay) params.capturedToDay = query.capturedToDay;
    where.push(`(
      (
        instr(COALESCE(v.captured_at, ''), 'T') > 0
        AND (${query.capturedFrom ? 'v.captured_at >= @capturedFrom' : '1'})
        AND (${query.capturedTo ? 'v.captured_at < @capturedTo' : '1'})
      )
      OR (
        v.captured_at IS NOT NULL
        AND instr(v.captured_at, 'T') = 0
        AND (${query.capturedFromDay ? 'v.captured_at >= @capturedFromDay' : '1'})
        AND (${query.capturedToDay ? 'v.captured_at <= @capturedToDay' : '1'})
      )
    )`);
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
    where.push('v.duration_ms < @durationMax');
  }

  const limit =
    query.limit != null
      ? `LIMIT ${Math.trunc(query.limit)} OFFSET ${Math.trunc(query.offset ?? 0)}`
      : '';
  const hasText = Boolean(match);
  const pageSql = `
    SELECT
      v.id AS id,
      COALESCE(NULLIF(TRIM(v.title), ''), (
        SELECT loc2.filename
        FROM video_locations loc2
        WHERE loc2.video_id = v.id
        ORDER BY CASE loc2.presence WHEN 'present' THEN 0 ELSE 1 END,
                 loc2.filename COLLATE NOCASE,
                 loc2.id
        LIMIT 1
      ), '') AS displayTitle,
      v.captured_at AS capturedAt,
      v.duration_ms AS durationMs
      ${hasText ? ', fts.rank AS rank' : ''}
    FROM videos v
    ${ftsJoin}
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderBy(query.sort, hasText, 'inner')}
    ${limit}
  `;
  const sql = `
    WITH page AS (${pageSql})
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
      page.displayTitle AS displayTitle,
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
      ${hasText ? 'page.rank' : 'NULL'} AS rank,
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
    FROM page
    JOIN videos v ON v.id = page.id
    LEFT JOIN video_locations loc ON loc.video_id = v.id
    LEFT JOIN libraries lib ON lib.id = loc.library_id
    LEFT JOIN styles s ON s.id = v.style_id
    GROUP BY v.id
    ORDER BY ${orderBy(query.sort, hasText, 'outer')}
  `;
  const countSql = `
    SELECT COUNT(*) AS total
    FROM videos v
    ${ftsJoin}
    WHERE ${where.join(' AND ')}
  `;
  return { sql, countSql, params };
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

function orderBy(sort: VideoSort | undefined, hasText: boolean, scope: 'inner' | 'outer'): string {
  const captured = scope === 'inner' ? 'v.captured_at' : 'page.capturedAt';
  const duration = scope === 'inner' ? 'v.duration_ms' : 'page.durationMs';
  const title = scope === 'inner' ? 'displayTitle' : 'page.displayTitle';
  const rank = scope === 'inner' ? 'rank' : 'page.rank';
  const id = 'v.id';
  switch (sort) {
    case 'oldest':
      return `CASE WHEN ${captured} IS NULL THEN 1 ELSE 0 END, ${captured} ASC, ${id} ASC`;
    case 'title':
      return `${title} COLLATE NOCASE ASC, ${id} ASC`;
    case 'title-desc':
      return `${title} COLLATE NOCASE DESC, ${id} ASC`;
    case 'longest':
      return `CASE WHEN ${duration} IS NULL THEN 1 ELSE 0 END, ${duration} DESC, ${id} ASC`;
    case 'shortest':
      return `CASE WHEN ${duration} IS NULL THEN 1 ELSE 0 END, ${duration} ASC, ${id} ASC`;
    case 'relevance':
      return hasText
        ? `${rank} ASC, ${id} ASC`
        : `CASE WHEN ${captured} IS NULL THEN 1 ELSE 0 END, ${captured} DESC, ${id} ASC`;
    case 'newest':
    default:
      return `CASE WHEN ${captured} IS NULL THEN 1 ELSE 0 END, ${captured} DESC, ${id} ASC`;
  }
}
