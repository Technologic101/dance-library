import {
  levels,
  videoTypes,
  type BulkVideoUpdate,
  type CatalogValueKind,
  type VideoUpdate,
} from '../shared/api';

const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;
const scalar = {
  title: 300,
  videoType: 0,
  styleId: 0,
  level: 0,
  eventName: 300,
  eventDate: 0,
  rating: 0,
  favorite: 0,
  notes: 10000,
} as const;

export function videoId(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('Invalid video id.');
  return value;
}
export function videoIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 500)
    throw new Error('Expected 1 to 500 video ids.');
  const ids = value.map(videoId);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate video ids.');
  return ids;
}
export function valueKind(value: unknown): CatalogValueKind {
  if (value !== 'style' && value !== 'instructor' && value !== 'tag')
    throw new Error('Invalid catalog value kind.');
  return value;
}
export function shortText(value: unknown, max = 120): string {
  if (typeof value !== 'string') throw new Error('Expected text.');
  const clean = value.trim();
  if (!clean || clean.length > max) throw new Error(`Text must be 1 to ${max} characters.`);
  return clean;
}
export function searchText(value: unknown): string {
  if (typeof value !== 'string' || value.length > 120) throw new Error('Invalid search text.');
  return value;
}
export function parseVideoUpdate(value: unknown, bulk: true): BulkVideoUpdate;
export function parseVideoUpdate(value: unknown, bulk?: false): VideoUpdate;
export function parseVideoUpdate(value: unknown, bulk = false): VideoUpdate | BulkVideoUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid update.');
  const allowed = new Set([
    ...Object.keys(scalar),
    ...(bulk
      ? ['addInstructorIds', 'removeInstructorIds', 'addTagIds', 'removeTagIds']
      : ['instructorIds', 'tagIds']),
  ]);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`Unknown update field: ${key}`);
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, max] of Object.entries(scalar))
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      const item = input[key];
      if (key === 'favorite') {
        if (typeof item !== 'boolean') throw new Error('favorite must be boolean.');
      } else if (key === 'rating') {
        if (
          item !== null &&
          (!Number.isInteger(item) || (item as number) < 1 || (item as number) > 5)
        )
          throw new Error('rating must be 1-5 or null.');
      } else if (key === 'videoType') {
        if (
          item !== null &&
          (typeof item !== 'string' || !videoTypes.some((type) => type === item))
        )
          throw new Error('Invalid video type.');
      } else if (key === 'level') {
        if (item !== null && (typeof item !== 'string' || !levels.some((level) => level === item)))
          throw new Error('Invalid level.');
      } else if (key === 'eventDate') {
        if (
          item !== null &&
          (typeof item !== 'string' ||
            !DATE.test(item) ||
            Number.isNaN(Date.parse(`${item}T00:00:00Z`)))
        )
          throw new Error('eventDate must be YYYY-MM-DD or null.');
      } else if (key === 'styleId') {
        if (item !== null) videoId(item);
      } else if (item !== null && (typeof item !== 'string' || item.length > (max as number)))
        throw new Error(`${key} is too long.`);
      out[key] = typeof item === 'string' ? item.trim() || null : item;
    }
  for (const key of allowed)
    if (key.endsWith('Ids') && Object.prototype.hasOwnProperty.call(input, key)) {
      const ids = input[key];
      if (!Array.isArray(ids) || ids.length > 500) throw new Error('Expected at most 500 ids.');
      out[key] = ids.map(videoId);
      if (new Set(out[key] as string[]).size !== (out[key] as string[]).length)
        throw new Error('Duplicate ids.');
    }
  if (!Object.keys(out).length) throw new Error('Update has no fields.');
  return out as VideoUpdate | BulkVideoUpdate;
}
