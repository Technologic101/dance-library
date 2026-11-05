import type { CatalogFacets, Level, VideoQuery, VideoSort, VideoType } from './api';
import { levels, videoSorts, videoTypes } from './api';

export const videoTypeLabels: Record<VideoType, string> = {
  lesson: 'Lesson',
  demo: 'Demo',
  'social dance': 'Social dance',
  performance: 'Performance',
};

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ID = /^[A-Za-z0-9:_-]{1,80}$/;

/** Upper bounds are exclusive, so a clip of exactly 20:00 is only in the next bucket. */
export const durationPresets = [
  { id: 'under-5', label: 'Under 5 min', minMs: 0, maxMs: 5 * 60 * 1000 },
  { id: '5-20', label: '5-20 min', minMs: 5 * 60 * 1000, maxMs: 20 * 60 * 1000 },
  { id: '20-60', label: '20-60 min', minMs: 20 * 60 * 1000, maxMs: 60 * 60 * 1000 },
  { id: 'over-60', label: 'Over 60 min', minMs: 60 * 60 * 1000, maxMs: null },
] as const;

export const videoPageSize = 48;

export type DurationPreset = (typeof durationPresets)[number]['id'];

export type BrowseFilters = {
  text: string;
  capturedFrom: string;
  capturedTo: string;
  videoType: VideoType | '';
  styleId: string;
  instructorId: string;
  level: Level | '';
  tagId: string;
  duration: DurationPreset | '';
  libraryId: string;
  favoriteOnly: boolean;
  sort: VideoSort;
};

export function emptyBrowseFilters(): BrowseFilters {
  return {
    text: '',
    capturedFrom: '',
    capturedTo: '',
    videoType: '',
    styleId: '',
    instructorId: '',
    level: '',
    tagId: '',
    duration: '',
    libraryId: '',
    favoriteOnly: false,
    sort: 'newest',
  };
}

export function filtersAreActive(filters: BrowseFilters): boolean {
  const empty = emptyBrowseFilters();
  return (Object.keys(empty) as (keyof BrowseFilters)[]).some(
    (key) => key !== 'sort' && filters[key] !== empty[key],
  );
}

/** Drops a style, instructor, tag, or folder that is no longer in the facet list. */
export function dropMissingFacets(filters: BrowseFilters, facets: CatalogFacets): BrowseFilters {
  const styleId = facets.styles.some((style) => style.id === filters.styleId)
    ? filters.styleId
    : '';
  const instructorId = facets.instructors.some(
    (instructor) => instructor.id === filters.instructorId,
  )
    ? filters.instructorId
    : '';
  const tagId = facets.tags.some((tag) => tag.id === filters.tagId) ? filters.tagId : '';
  const libraryId = facets.libraries.some((library) => library.id === filters.libraryId)
    ? filters.libraryId
    : '';
  if (
    styleId === filters.styleId &&
    instructorId === filters.instructorId &&
    tagId === filters.tagId &&
    libraryId === filters.libraryId
  ) {
    return filters;
  }
  return { ...filters, styleId, instructorId, tagId, libraryId };
}

export function toVideoQuery(filters: BrowseFilters, excluded: boolean): VideoQuery {
  const query: VideoQuery = { excluded, sort: filters.sort };
  const text = filters.text.trim();
  if (text) query.text = text;
  const bounds = localDayBounds(
    isDay(filters.capturedFrom) ? filters.capturedFrom : undefined,
    isDay(filters.capturedTo) ? filters.capturedTo : undefined,
  );
  if (bounds.from) query.capturedFrom = bounds.from;
  if (bounds.toExclusive) query.capturedTo = bounds.toExclusive;
  if (isDay(filters.capturedFrom)) query.capturedFromDay = filters.capturedFrom;
  if (isDay(filters.capturedTo)) query.capturedToDay = filters.capturedTo;
  if (filters.videoType) query.videoTypes = [filters.videoType];
  if (filters.styleId) query.styleIds = [filters.styleId];
  if (filters.instructorId) query.instructorIds = [filters.instructorId];
  if (filters.level) query.levels = [filters.level];
  if (filters.tagId) query.tagIds = [filters.tagId];
  if (filters.libraryId) query.libraryIds = [filters.libraryId];
  if (filters.favoriteOnly) query.favorite = true;
  const preset = durationPresets.find((item) => item.id === filters.duration);
  if (preset && preset.minMs > 0) query.durationMinMs = preset.minMs;
  if (preset && preset.maxMs != null) query.durationMaxMs = preset.maxMs;
  query.limit = videoPageSize;
  return query;
}

/**
 * FTS5 query for titles, notes, tags, and filenames.
 * Returns null when there is nothing to search, or an empty string when the
 * text cannot match any token and the result must be empty.
 */
export function ftsMatch(text: string): string | null {
  if (text.trim().length === 0) return null;
  const tokens = text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0 && token.length <= 64)
    .slice(0, 8);
  if (tokens.length === 0) return '';
  return tokens.map((token) => `"${token}"*`).join(' AND ');
}

export function parseVideoQuery(value: unknown): VideoQuery {
  const source = record(value);
  const query: VideoQuery = {};
  if (source.excluded === true) query.excluded = true;
  if (typeof source.text === 'string') {
    const text = source.text.trim().slice(0, 200);
    if (text) query.text = text;
  }
  const from = instant(source.capturedFrom);
  const to = instant(source.capturedTo);
  if (from) query.capturedFrom = from;
  if (to) query.capturedTo = to;
  const types = enums(source.videoTypes, videoTypes);
  const pickedLevels = enums(source.levels, levels);
  const styles = ids(source.styleIds);
  const instructors = ids(source.instructorIds);
  const tags = ids(source.tagIds);
  const libraries = ids(source.libraryIds);
  if (types.length > 0) query.videoTypes = types;
  if (pickedLevels.length > 0) query.levels = pickedLevels;
  if (styles.length > 0) query.styleIds = styles;
  if (instructors.length > 0) query.instructorIds = instructors;
  if (tags.length > 0) query.tagIds = tags;
  if (libraries.length > 0) query.libraryIds = libraries;
  const min = milliseconds(source.durationMinMs);
  const max = milliseconds(source.durationMaxMs);
  if (min != null) query.durationMinMs = min;
  if (max != null) query.durationMaxMs = max;
  if (source.favorite === true) query.favorite = true;
  if (typeof source.sort === 'string' && videoSorts.some((sort) => sort === source.sort)) {
    query.sort = source.sort as VideoSort;
  }
  const limit = boundedInt(source.limit, 1, 200);
  const offset = boundedInt(source.offset, 0, 1_000_000);
  if (limit != null) query.limit = limit;
  if (offset != null) query.offset = offset;
  return query;
}

/**
 * Local calendar days as UTC instants. `toExclusive` is the next local midnight,
 * so the selected end day is included. Each date uses the local constructor,
 * which applies that date's own DST offset.
 */
export function localDayBounds(
  fromDay?: string,
  toDay?: string,
): { from?: string; toExclusive?: string } {
  return {
    from: fromDay ? instantAtLocalMidnight(fromDay, 0) : undefined,
    toExclusive: toDay ? instantAtLocalMidnight(toDay, 1) : undefined,
  };
}

/** When a result page is empty but earlier pages still have rows, move back. */
export function pageAfterShrink(page: number, total: number, pageSize: number): number | null {
  if (page <= 0 || total <= 0 || pageSize <= 0) return null;
  const last = Math.ceil(total / pageSize) - 1;
  if (page > last) return last;
  return null;
}

function instantAtLocalMidnight(day: string, addDays: number): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, (date ?? 1) + addDays).toISOString();
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function isDay(value: string): boolean {
  return day(value) !== null;
}

function day(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = DAY.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, date));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== date
  ) {
    return null;
  }
  return value;
}

function enums<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(value)) return [];
  const picked: T[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const match = allowed.find((candidate) => candidate === item);
    if (match && !picked.includes(match)) picked.push(match);
    if (picked.length === 8) break;
  }
  return picked;
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const picked: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !ID.test(item) || picked.includes(item)) continue;
    picked.push(item);
    if (picked.length === 20) break;
  }
  return picked;
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function instant(value: unknown): string | null {
  if (typeof value !== 'string' || !INSTANT.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function boundedInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

function milliseconds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  if (value > 24 * 60 * 60 * 1000) return null;
  return value;
}
