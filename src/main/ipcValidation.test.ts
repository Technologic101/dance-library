import { describe, expect, it } from 'vitest';
import {
  noArguments,
  optionalUndoToken,
  parseVideoUpdate,
  shortText,
  valueKind,
  videoIds,
} from './ipcValidation';
describe('catalog IPC validation', () => {
  it('accepts a strict valid update', () =>
    expect(
      parseVideoUpdate({
        videoType: 'lesson',
        eventDate: '2024-02-29',
        rating: 5,
        favorite: true,
        tagIds: [],
      }),
    ).toEqual({
      videoType: 'lesson',
      eventDate: '2024-02-29',
      rating: 5,
      favorite: true,
      tagIds: [],
    }));
  it.each([
    { wat: true },
    { rating: 0 },
    { rating: 6 },
    { eventDate: '03/10/2024' },
    { eventDate: '2024-02-30' },
    { videoType: 'class' },
    { favorite: 1 },
    { notes: 'x'.repeat(10001) },
  ])('rejects invalid update %j', (value) => expect(() => parseVideoUpdate(value)).toThrow());
  it('validates kinds, names and capped unique id arrays', () => {
    expect(valueKind('tag')).toBe('tag');
    expect(() => valueKind('person')).toThrow();
    expect(shortText(' Alice ')).toBe('Alice');
    expect(() => shortText('  ')).toThrow();
    expect(() => videoIds([])).toThrow();
    expect(() => videoIds(['a', 'a'])).toThrow();
    expect(() => videoIds(Array.from({ length: 501 }, (_, i) => `v${i}`))).toThrow();
  });
  it('strictly rejects arguments to no-argument IPC operations', () => {
    expect(() => noArguments([])).not.toThrow();
    expect(() => noArguments(['unexpected'])).toThrow(/no arguments/);
  });
  it('accepts only one strictly validated undo token', () => {
    expect(optionalUndoToken([])).toBeUndefined();
    expect(optionalUndoToken(['save-1'])).toBe('save-1');
    expect(() => optionalUndoToken([1])).toThrow(/token/);
    expect(() => optionalUndoToken(['save-1', 'save-2'])).toThrow(/at most one/);
  });
});
