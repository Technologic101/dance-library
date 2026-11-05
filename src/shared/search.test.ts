import { describe, expect, it } from 'vitest';
import {
  emptyBrowseFilters,
  filtersAreActive,
  ftsMatch,
  localDayBounds,
  pageAfterShrink,
  parseVideoQuery,
  toVideoQuery,
} from './search';

describe('search query', () => {
  it('turns typed words into a prefix query and drops operators', () => {
    expect(ftsMatch('  Zouk lady ')).toBe('"zouk"* AND "lady"*');
    expect(ftsMatch('forró')).toBe('"forro"*');
    expect(ftsMatch('   ')).toBeNull();
    expect(ftsMatch('" OR 1=1 --')).toBe('"or"* AND "1"* AND "1"*');
  });

  it('keeps only known filter values from the renderer', () => {
    expect(
      parseVideoQuery({
        text: '  zouk  ',
        sort: 'title; drop table',
        videoTypes: ['lesson', 'recital'],
        levels: ['Intermediate'],
        styleIds: ['builtin:zouk', 'style name'],
        favorite: true,
        capturedFrom: '2024-06-01T07:00:00.000Z',
        capturedTo: '2024-13-40',
        durationMinMs: 5 * 60 * 1000,
        durationMaxMs: -1,
        excluded: false,
      }),
    ).toEqual({
      text: 'zouk',
      videoTypes: ['lesson'],
      levels: ['Intermediate'],
      styleIds: ['builtin:zouk'],
      favorite: true,
      capturedFrom: '2024-06-01T07:00:00.000Z',
      durationMinMs: 5 * 60 * 1000,
    });
  });

  it('maps the browse form onto a catalog query', () => {
    const filters = {
      ...emptyBrowseFilters(),
      text: ' wave ',
      videoType: 'lesson' as const,
      duration: '5-20' as const,
      favoriteOnly: true,
      sort: 'title' as const,
    };
    expect(toVideoQuery(filters, false)).toEqual({
      excluded: false,
      sort: 'title',
      text: 'wave',
      videoTypes: ['lesson'],
      favorite: true,
      durationMinMs: 5 * 60 * 1000,
      durationMaxMs: 20 * 60 * 1000,
      limit: 48,
    });
  });

  it("turns a local day into that date's own midnight", () => {
    expect(localDayBounds('2024-06-30', '2024-06-30')).toEqual({
      from: new Date(2024, 5, 30).toISOString(),
      toExclusive: new Date(2024, 6, 1).toISOString(),
    });
  });

  it('moves back from an empty page when the catalog shrinks', () => {
    expect(pageAfterShrink(3, 144, 48)).toBe(2);
    expect(pageAfterShrink(1, 48, 48)).toBe(0);
    expect(pageAfterShrink(0, 10, 48)).toBeNull();
    expect(pageAfterShrink(1, 0, 48)).toBeNull();
  });

  it('does not treat a sort change as a filter', () => {
    expect(filtersAreActive({ ...emptyBrowseFilters(), sort: 'oldest' })).toBe(false);
    expect(filtersAreActive({ ...emptyBrowseFilters(), text: 'zouk' })).toBe(true);
  });
});
