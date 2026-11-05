import { describe, expect, it } from 'vitest';
import {
  emptyBrowseFilters,
  filtersAreActive,
  ftsMatch,
  localDayBounds,
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

  it('turns a local day into an inclusive UTC range', () => {
    expect(localDayBounds('2024-06-30', '2024-06-30', 420)).toEqual({
      from: '2024-06-30T07:00:00.000Z',
      toExclusive: '2024-07-01T07:00:00.000Z',
    });
  });

  it('does not treat a sort change as a filter', () => {
    expect(filtersAreActive({ ...emptyBrowseFilters(), sort: 'oldest' })).toBe(false);
    expect(filtersAreActive({ ...emptyBrowseFilters(), text: 'zouk' })).toBe(true);
  });
});
