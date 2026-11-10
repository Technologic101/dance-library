// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppHealth,
  BulkVideoUpdate,
  CatalogFacets,
  LibrarySummary,
  VideoDetails,
  VideoListItem,
} from '../shared/api';
import { formatVideoMeta } from '../shared/format';
import { App } from './App';

const health: AppHealth = {
  appVersion: '0.0.1',
  database: { ok: true, schemaVersion: 2, path: '/tmp/catalog.sqlite' },
  ffprobe: { ok: true, version: 'n7.1' },
  autoUpdate: 'disabled',
};

const library: LibrarySummary = {
  id: 'lib',
  path: '/dance',
  label: 'dance',
  availability: 'online',
  videoCount: 1,
  missingCount: 1,
  lastScannedAt: '2024-06-02T00:00:00.000Z',
  lastError: null,
};

const present: VideoListItem = {
  id: 'vid-1',
  title: null,
  displayTitle: 'lesson-basic.mp4',
  videoType: null,
  styleName: null,
  level: null,
  favorite: false,
  instructors: [],
  tags: [],
  sizeBytes: 120 * 1024,
  durationMs: 2000,
  width: 640,
  height: 360,
  videoCodec: 'h264',
  capturedAt: '2024-06-01T15:04:05.000Z',
  capturedAtSource: 'metadata',
  presence: 'present',
  metadataError: null,
  thumbnailUrl: 'dance-thumb://thumbs/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg',
  excluded: false,
  locations: [
    {
      id: 'loc-1',
      libraryId: 'lib',
      libraryLabel: 'dance',
      path: '/dance/lesson-basic.mp4',
      filename: 'lesson-basic.mp4',
      presence: 'present',
    },
    {
      id: 'loc-2',
      libraryId: 'lib',
      libraryLabel: 'dance',
      path: '/dance/lesson-basic-copy.mp4',
      filename: 'lesson-basic-copy.mp4',
      presence: 'present',
    },
  ],
};

const missing: VideoListItem = {
  ...present,
  id: 'vid-2',
  displayTitle: 'gone.mp4',
  durationMs: 5000,
  videoCodec: 'hevc',
  presence: 'missing',
  thumbnailUrl: null,
  locations: [
    {
      id: 'loc-3',
      libraryId: 'lib',
      libraryLabel: 'dance',
      path: '/dance/gone.mp4',
      filename: 'gone.mp4',
      presence: 'missing',
    },
  ],
};

const emptyFacets: CatalogFacets = {
  styles: [],
  instructors: [],
  tags: [],
  libraries: [{ id: 'lib', label: 'dance' }],
};

function apiDetails(id: string): VideoDetails {
  return {
    id,
    displayTitle: present.displayTitle,
    title: null,
    videoType: null,
    style: null,
    instructors: [],
    level: null,
    eventName: null,
    eventDate: null,
    tags: [],
    rating: null,
    favorite: false,
    notes: null,
    lessonDemos: [],
  };
}

function api(overrides: Partial<NonNullable<typeof window.danceLibrary>> = {}) {
  const notify = vi.fn(async () => {});
  window.danceLibrary = {
    getHealth: async () => health,
    notifyViewReady: notify,
    listLibraries: async () => [library],
    listVideos: async () => ({ items: [present, missing], total: 2 }),
    listFacets: async () => emptyFacets,
    countVideos: async () => ({ visible: 2, excluded: 0 }),
    excludeVideos: async () => ({ changed: 1, requested: 1 }),
    restoreVideos: async () => ({ changed: 1, requested: 1 }),
    getVideoDetails: async (id) => ({
      id,
      displayTitle: present.displayTitle,
      title: null,
      videoType: null,
      style: null,
      instructors: [],
      level: null,
      eventName: null,
      eventDate: null,
      tags: [],
      rating: null,
      favorite: false,
      notes: null,
      lessonDemos: [],
    }),
    updateVideo: async (id) => ({
      id,
      displayTitle: present.displayTitle,
      title: null,
      videoType: null,
      style: null,
      instructors: [],
      level: null,
      eventName: null,
      eventDate: null,
      tags: [],
      rating: null,
      favorite: false,
      notes: null,
      lessonDemos: [],
    }),
    bulkUpdateVideos: async (ids) => ({ changed: ids.length, requested: ids.length }),
    searchCatalogValues: async () => [],
    createCatalogValue: async (_kind, name) => ({ id: name.toLowerCase(), name }),
    linkLessonDemo: async () => {},
    unlinkLessonDemo: async () => {},
    addLibraries: async () => ({ added: [library], skipped: [], scan: null }),
    removeLibrary: async () => ({ ok: true }),
    scanLibrary: async () => ({
      libraries: 1,
      discovered: 1,
      added: 0,
      updated: 0,
      unchanged: 1,
      linked: 0,
      missing: 0,
      offline: 0,
      errors: 0,
    }),
    scanAll: async () => ({
      libraries: 1,
      discovered: 1,
      added: 0,
      updated: 0,
      unchanged: 1,
      linked: 0,
      missing: 0,
      offline: 0,
      errors: 0,
    }),
    onScanProgress: () => () => {},
    ...overrides,
  };
  return notify;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  api();
});

describe('App', () => {
  it('shows the catalog and technical metadata', async () => {
    const notify = api();
    render(<App />);
    expect(screen.getAllByText(/checking the runtime/i).length).toBeGreaterThan(0);
    expect(await screen.findByRole('heading', { name: 'lesson-basic.mp4' })).toBeTruthy();
    expect(screen.getByText(formatVideoMeta(present))).toBeTruthy();
    expect(screen.getByText('2 copies')).toBeTruthy();
    expect(screen.getByText('Online · /dance/lesson-basic-copy.mp4')).toBeTruthy();
    expect(screen.getByText(/Missing/)).toBeTruthy();
    expect(
      screen.getByRole('img', { name: /lesson-basic\.mp4 thumbnail/ }).getAttribute('src'),
    ).toMatch(/^dance-thumb:/);
    expect(screen.getByText(/never moves, modifies, or deletes/i)).toBeTruthy();
    expect(screen.getByText('Database schema 2 · ffprobe n7.1')).toBeTruthy();
    await waitFor(() => expect(notify).toHaveBeenCalled());
  });

  it('switches between grid and list', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'lesson-basic.mp4' })).toBeTruthy();
    const list = screen.getByRole('button', { name: 'List' });
    fireEvent.click(list);
    expect(list.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Grid' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('adds a folder and shows a skip message', async () => {
    const addLibraries = vi.fn(async () => ({
      added: [],
      skipped: [{ path: '/dance', message: 'That folder is already in the library.' }],
      scan: null,
    }));
    api({ addLibraries });
    render(<App />);
    await screen.findByRole('heading', { name: 'lesson-basic.mp4' });
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }));
    expect(await screen.findByText(/already in the library/)).toBeTruthy();
    expect(addLibraries).toHaveBeenCalledOnce();
  });

  it('removes the selected videos from the catalog', async () => {
    const excludeVideos = vi.fn(async () => ({ changed: 2, requested: 2 }));
    api({ excludeVideos });
    render(<App />);
    await screen.findByRole('heading', { name: 'lesson-basic.mp4' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select lesson-basic.mp4' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select gone.mp4' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove from library (2)' }));
    await waitFor(() => expect(excludeVideos).toHaveBeenCalledWith(['vid-1', 'vid-2']));
  });

  it('opens the editor in StrictMode and completes a keyboard save', async () => {
    const updateVideo = vi.fn(async (id) => ({
      id,
      displayTitle: 'My lesson',
      title: 'My lesson',
      videoType: 'lesson' as const,
      style: null,
      instructors: [],
      level: null,
      eventName: null,
      eventDate: '2024-03-10',
      tags: [],
      rating: 4,
      favorite: false,
      notes: null,
      lessonDemos: [],
    }));
    api({ updateVideo });
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await screen.findByRole('heading', { name: 'lesson-basic.mp4' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'e' });
    const title = await screen.findByRole('textbox', { name: 'Title' });
    fireEvent.change(title, { target: { value: 'My lesson' } });
    fireEvent.keyDown(title.closest('aside')!, { key: 's', ctrlKey: true });
    await waitFor(() => expect(updateVideo).toHaveBeenCalledWith('vid-1', { title: 'My lesson' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('clears a single video date as null', async () => {
    const updateVideo = vi.fn(async (id: string) => ({
      ...apiDetails(id),
      eventDate: null,
    }));
    api({
      updateVideo,
      getVideoDetails: async (id) => ({
        ...(await apiDetails(id)),
        eventDate: '2024-03-10',
      }),
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'lesson-basic.mp4' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'e' });
    const date = await screen.findByLabelText('Date');
    fireEvent.change(date, { target: { value: '' } });
    fireEvent.keyDown(date.closest('aside')!, { key: 's', ctrlKey: true });
    await waitFor(() => expect(updateVideo).toHaveBeenCalledWith('vid-1', { eventDate: null }));
  });

  it('clears a single video style as null', async () => {
    const updateVideo = vi.fn(async (id: string) => apiDetails(id));
    api({
      updateVideo,
      getVideoDetails: async (id) => ({
        ...(await apiDetails(id)),
        style: { id: 'zouk', name: 'Zouk' },
      }),
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'lesson-basic.mp4' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'e' });
    const editor = await screen.findByRole('dialog');
    const style = within(editor).getByRole('combobox', { name: 'Style' });
    fireEvent.change(style, { target: { value: '' } });
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true });
    await waitFor(() => expect(updateVideo).toHaveBeenCalledWith('vid-1', { styleId: null }));
  });

  it('shows save errors in StrictMode and restores the save button', async () => {
    api({ updateVideo: vi.fn(async () => Promise.reject(new Error('Catalog is locked'))) });
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await screen.findByRole('heading', { name: 'lesson-basic.mp4' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'e' });
    const title = await screen.findByRole('textbox', { name: 'Title' });
    fireEvent.change(title, { target: { value: 'Unsaved' } });
    fireEvent.keyDown(title.closest('aside')!, { key: 's', ctrlKey: true });
    expect((await screen.findByRole('alert')).textContent).toContain('Catalog is locked');
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false);
  });

  it('bulk editing starts mixed and sends only explicit add operations', async () => {
    const bulkUpdateVideos = vi.fn(async (ids: string[]) => ({
      changed: ids.length,
      requested: ids.length,
    }));
    api({
      bulkUpdateVideos,
      getVideoDetails: async (id) => ({
        id,
        displayTitle: id,
        title: null,
        videoType: null,
        style: null,
        instructors: id === 'vid-1' ? [{ id: 'alice', name: 'Alice' }] : [],
        level: null,
        eventName: null,
        eventDate: null,
        tags:
          id === 'vid-1'
            ? [{ id: 'musicality', name: 'Musicality' }]
            : [{ id: 'body', name: 'Body wave' }],
        rating: null,
        favorite: false,
        notes: null,
        lessonDemos: [],
      }),
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'lesson-basic.mp4' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(window, { key: 'e' });
    const addTags = await screen.findByRole('combobox', { name: 'Add tags' });
    fireEvent.change(addTags, { target: { value: 'Viradinha' } });
    fireEvent.keyDown(addTags.closest('aside')!, { key: 's', ctrlKey: true });
    await waitFor(() =>
      expect(bulkUpdateVideos).toHaveBeenCalledWith(['vid-1', 'vid-2'], {
        addTagIds: ['viradinha'],
      }),
    );
  });

  it('tabs through the whole bulk form without accepting autocomplete suggestions', async () => {
    const bulkUpdateVideos = vi.fn(async (ids: string[]) => ({
      changed: ids.length,
      requested: ids.length,
    }));
    api({
      bulkUpdateVideos,
      searchCatalogValues: async () => [{ id: 'afro', name: 'Afro' }],
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'lesson-basic.mp4' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(window, { key: 'e' });
    const addTags = await screen.findByRole('combobox', { name: 'Add tags' });
    fireEvent.change(addTags, { target: { value: 'Viradinha' } });
    const suggestion = await screen.findByRole('option', { name: 'Afro' });
    expect(suggestion).toBeTruthy();
    expect(addTags.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(addTags, { key: 'ArrowDown' });
    fireEvent.keyDown(addTags, { key: 'Tab' });
    expect((addTags as HTMLInputElement).value).toBe('Viradinha');

    const panel = addTags.closest('aside')!;
    for (const field of panel.querySelectorAll<HTMLElement>('input, select, textarea')) {
      field.focus();
      fireEvent.keyDown(field, { key: 'Tab' });
    }
    expect((addTags as HTMLInputElement).value).toBe('Viradinha');
    fireEvent.keyDown(panel, { key: 's', ctrlKey: true });
    await waitFor(() =>
      expect(bulkUpdateVideos).toHaveBeenCalledWith(['vid-1', 'vid-2'], {
        addTagIds: ['viradinha'],
      }),
    );
  });

  it('searches and applies tag autocomplete with the keyboard', async () => {
    const searchCatalogValues = vi.fn(async (_kind, query) =>
      query === 'mus' ? [{ id: 'music', name: 'Musicality' }] : [],
    );
    api({ searchCatalogValues });
    render(<App />);
    await screen.findByRole('heading', { name: 'lesson-basic.mp4' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'e' });
    const tags = await screen.findByRole('combobox', { name: 'Tags (comma separated)' });
    fireEvent.change(tags, { target: { value: 'mus' } });
    expect(await screen.findByRole('option', { name: 'Musicality' })).toBeTruthy();
    fireEvent.keyDown(tags, { key: 'ArrowDown' });
    fireEvent.keyDown(tags, { key: 'Enter' });
    expect((tags as HTMLInputElement).value).toBe('Musicality');
  });

  it('does not accept autocomplete results from the previous token', async () => {
    let resolveSearch: ((values: { id: string; name: string }[]) => void) | undefined;
    const searchCatalogValues = vi.fn(
      () =>
        new Promise<{ id: string; name: string }[]>((resolve) => {
          resolveSearch = resolve;
        }),
    );
    api({
      searchCatalogValues,
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'lesson-basic.mp4' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'e' });
    const tags = await screen.findByRole('combobox', { name: 'Tags (comma separated)' });
    fireEvent.change(tags, { target: { value: 'Sal' } });
    await waitFor(() => expect(searchCatalogValues).toHaveBeenCalledWith('tag', 'Sal'));
    await act(async () => resolveSearch?.([{ id: 'salsa', name: 'Salsa On1' }]));
    expect(await screen.findByRole('option', { name: 'Salsa On1' })).toBeTruthy();
    fireEvent.change(tags, { target: { value: 'Zouk' } });
    fireEvent.keyDown(tags, { key: 'Enter' });
    expect((tags as HTMLInputElement).value).toBe('Zouk');
  });

  it('lets Escape close the editor when a combo only has stale suggestions', async () => {
    api({
      searchCatalogValues: async (_kind, query) =>
        query === 'Zo' ? [{ id: 'zouk', name: 'Zouk' }] : [],
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'lesson-basic.mp4' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'e' });
    const editor = await screen.findByRole('dialog');
    const style = within(editor).getByRole('combobox', { name: 'Style' });
    fireEvent.change(style, { target: { value: 'Zo' } });
    expect(await screen.findByRole('option', { name: 'Zouk' })).toBeTruthy();
    fireEvent.change(style, { target: { value: 'Zou' } });
    expect(screen.queryByRole('option', { name: 'Zouk' })).toBeNull();
    fireEvent.keyDown(style, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('lets Escape close the editor from an empty link picker', async () => {
    api({
      getVideoDetails: async (id) => ({
        id,
        displayTitle: present.displayTitle,
        title: null,
        videoType: 'lesson',
        style: null,
        instructors: [],
        level: null,
        eventName: null,
        eventDate: null,
        tags: [],
        rating: null,
        favorite: false,
        notes: null,
        lessonDemos: [],
      }),
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'lesson-basic.mp4' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'e' });
    const picker = await screen.findByRole('combobox', { name: 'Find lesson or demo' });
    fireEvent.keyDown(picker, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('restores a bulk field and focus when leaving it unchanged', async () => {
    const bulkUpdateVideos = vi.fn(async (ids: string[]) => ({
      changed: ids.length,
      requested: ids.length,
    }));
    api({
      bulkUpdateVideos,
      getVideoDetails: async (id) => ({
        id,
        displayTitle: id,
        title: null,
        videoType: null,
        style: null,
        instructors: [],
        level: null,
        eventName: id === 'vid-1' ? 'First event' : 'Second event',
        eventDate: '2024-05-01',
        tags: [],
        rating: null,
        favorite: false,
        notes: null,
        lessonDemos: [],
      }),
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'lesson-basic.mp4' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(window, { key: 'e' });
    const event = await screen.findByRole('textbox', { name: 'Event' });
    fireEvent.change(event, { target: { value: 'Changed event' } });
    fireEvent.click(screen.getByRole('button', { name: 'Leave event unchanged' }));
    expect((event as HTMLInputElement).value).toBe('');
    expect(event.getAttribute('placeholder')).toBe('— Mixed / unchanged —');
    await waitFor(() => expect(document.activeElement).toBe(event));
    const addTags = screen.getByRole('combobox', { name: 'Add tags' });
    fireEvent.change(addTags, { target: { value: 'Practice' } });
    fireEvent.keyDown(addTags.closest('aside')!, { key: 's', ctrlKey: true });
    await waitFor(() =>
      expect(bulkUpdateVideos).toHaveBeenCalledWith(['vid-1', 'vid-2'], {
        addTagIds: ['practice'],
      }),
    );
  });

  it('shows an error and does not create an unknown removal tag', async () => {
    const bulkUpdateVideos = vi.fn(async (ids: string[]) => ({
      changed: ids.length,
      requested: ids.length,
    }));
    const createCatalogValue = vi.fn(async (_kind, name: string) => ({
      id: name.toLowerCase(),
      name,
    }));
    api({ bulkUpdateVideos, createCatalogValue, searchCatalogValues: async () => [] });
    render(<App />);
    await screen.findByRole('heading', { name: 'lesson-basic.mp4' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(window, { key: 'e' });
    const removeTags = await screen.findByRole('combobox', { name: 'Remove tags' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Add tags' }), {
      target: { value: 'Practice' },
    });
    fireEvent.change(removeTags, { target: { value: 'Misspelled' } });
    fireEvent.keyDown(removeTags.closest('aside')!, { key: 's', ctrlKey: true });
    expect((await screen.findByRole('alert')).textContent).toContain('Unknown tag: Misspelled');
    expect(createCatalogValue).not.toHaveBeenCalled();
    expect(bulkUpdateVideos).not.toHaveBeenCalled();
  });

  it('does not clear bulk style or date after typing and deleting', async () => {
    const bulkUpdateVideos = vi.fn(async (ids: string[], patch: BulkVideoUpdate) => {
      void patch;
      return { changed: ids.length, requested: ids.length };
    });
    api({ bulkUpdateVideos });
    render(<App />);
    await screen.findByRole('heading', { name: 'lesson-basic.mp4' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(window, { key: 'e' });

    const editor = await screen.findByRole('dialog', { name: 'Bulk edit 2 videos' });
    const style = within(editor).getByRole('combobox', { name: 'Style' });
    fireEvent.change(style, { target: { value: 'z' } });
    fireEvent.click(screen.getByRole('button', { name: 'Leave style unchanged' }));
    await waitFor(() => expect(document.activeElement).toBe(style));
    fireEvent.change(style, { target: { value: 'z' } });
    fireEvent.change(style, { target: { value: '' } });

    const date = screen.getByLabelText('Date');
    fireEvent.change(date, { target: { value: '2024-05-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Leave date unchanged' }));
    await waitFor(() => expect(document.activeElement).toBe(date));
    fireEvent.change(date, { target: { value: '2024-05-01' } });
    fireEvent.change(date, { target: { value: '' } });

    const addTags = screen.getByRole('combobox', { name: 'Add tags' });
    fireEvent.change(addTags, { target: { value: 'Practice' } });
    fireEvent.keyDown(addTags.closest('aside')!, { key: 's', ctrlKey: true });
    await waitFor(() =>
      expect(bulkUpdateVideos).toHaveBeenCalledWith(['vid-1', 'vid-2'], {
        addTagIds: ['practice'],
      }),
    );
    const patch = bulkUpdateVideos.mock.calls[0]?.[1];
    expect(patch).not.toHaveProperty('styleId');
    expect(patch).not.toHaveProperty('eventDate');
  });

  it('keeps typed-empty shared bulk values unchanged without joining a replacement style', async () => {
    const bulkUpdateVideos = vi.fn(async (ids: string[]) => ({
      changed: ids.length,
      requested: ids.length,
    }));
    api({
      bulkUpdateVideos,
      getVideoDetails: async (id) => ({
        ...(await apiDetails(id)),
        style: { id: 'zouk', name: 'Zouk' },
        eventDate: '2024-05-01',
      }),
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'lesson-basic.mp4' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(window, { key: 'e' });

    const editor = await screen.findByRole('dialog', { name: 'Bulk edit 2 videos' });
    const style = within(editor).getByRole('combobox', { name: 'Style' });
    fireEvent.change(style, { target: { value: '' } });
    expect((style as HTMLInputElement).value).toBe('');
    fireEvent.click(within(editor).getByRole('button', { name: 'Leave style unchanged' }));
    expect((style as HTMLInputElement).value).toBe('Zouk');
    fireEvent.change(style, { target: { value: '' } });
    fireEvent.change(style, { target: { value: 'Samba' } });
    expect((style as HTMLInputElement).value).toBe('Samba');

    const date = within(editor).getByLabelText('Date');
    fireEvent.change(date, { target: { value: '' } });
    expect((date as HTMLInputElement).value).toBe('');
    fireEvent.click(within(editor).getByRole('button', { name: 'Leave date unchanged' }));
    expect((date as HTMLInputElement).value).toBe('2024-05-01');
    fireEvent.change(date, { target: { value: '' } });
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true });
    await waitFor(() =>
      expect(bulkUpdateVideos).toHaveBeenCalledWith(['vid-1', 'vid-2'], {
        styleId: 'samba',
      }),
    );
  });

  it('shows armed bulk-clear hints and saves null style and date values', async () => {
    const bulkUpdateVideos = vi.fn(async (ids: string[]) => ({
      changed: ids.length,
      requested: ids.length,
    }));
    api({ bulkUpdateVideos });
    render(<App />);
    await screen.findByRole('heading', { name: 'lesson-basic.mp4' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(window, { key: 'e' });
    const editor = await screen.findByRole('dialog', { name: 'Bulk edit 2 videos' });
    fireEvent.click(within(editor).getByRole('button', { name: 'Clear style on all' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Clear date on all' }));
    expect(within(editor).getAllByText('Will be cleared on 2 videos')).toHaveLength(2);
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true });
    await waitFor(() =>
      expect(bulkUpdateVideos).toHaveBeenCalledWith(['vid-1', 'vid-2'], {
        styleId: null,
        eventDate: null,
      }),
    );
  });

  it('keeps the edited video selected after save so ArrowDown selects the next video', async () => {
    api();
    render(<App />);
    await screen.findByRole('heading', { name: 'lesson-basic.mp4' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'e' });
    const title = await screen.findByRole('textbox', { name: 'Title' });
    fireEvent.change(title, { target: { value: 'Edited' } });
    fireEvent.keyDown(title.closest('aside')!, { key: 's', ctrlKey: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /gone\.mp4/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('applies a library refresh even when a newer search replaces the page', async () => {
    let resolveLibraries: (libraries: LibrarySummary[]) => void = () => {};
    let libraryCalls = 0;
    const listVideos = vi.fn(async (query) => {
      if (query?.text === 'bolero') return { items: [present], total: 1 };
      return { items: [present, missing], total: 2 };
    });
    api({
      listLibraries: () => {
        libraryCalls += 1;
        if (libraryCalls === 1) return Promise.resolve([library]);
        return new Promise((resolve) => {
          resolveLibraries = resolve;
        });
      },
      listVideos,
      scanLibrary: async () => ({
        libraries: 1,
        discovered: 2,
        added: 0,
        updated: 0,
        unchanged: 2,
        linked: 0,
        missing: 0,
        offline: 0,
        errors: 0,
      }),
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rescan dance' }));
    await waitFor(() => expect(libraryCalls).toBe(2));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'bolero' },
    });
    await waitFor(() =>
      expect(listVideos).toHaveBeenCalledWith(expect.objectContaining({ text: 'bolero' })),
    );
    resolveLibraries([{ ...library, label: 'renamed', videoCount: 9 }]);
    expect(await screen.findByRole('button', { name: 'Rescan renamed' })).toBeTruthy();
  });

  it('rescans a folder', async () => {
    const scanLibrary = vi.fn(async () => ({
      libraries: 1,
      discovered: 2,
      added: 0,
      updated: 0,
      unchanged: 2,
      linked: 0,
      missing: 0,
      offline: 0,
      errors: 0,
    }));
    api({ scanLibrary });
    render(<App />);
    await screen.findByRole('heading', { name: 'lesson-basic.mp4' });
    fireEvent.click(screen.getByRole('button', { name: 'Rescan dance' }));
    await waitFor(() => expect(scanLibrary).toHaveBeenCalledWith('lib'));
  });

  it('waits to search until typing pauses', async () => {
    vi.useFakeTimers();
    const listVideos = vi.fn(async () => ({ items: [present], total: 1 }));
    api({ listVideos });
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    const before = listVideos.mock.calls.length;
    expect(before).toBeGreaterThan(0);
    const box = screen.getByRole('searchbox', { name: 'Search' });
    for (const value of ['b', 'bo', 'bol', 'bole', 'bolero']) {
      fireEvent.change(box, { target: { value } });
    }
    expect(listVideos.mock.calls.length).toBe(before);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(listVideos.mock.calls.length).toBe(before + 1);
    expect(listVideos).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'bolero' }));
  });

  it('filters the catalog from the search box', async () => {
    const listVideos = vi.fn(async (query) => {
      const items = query?.text === 'zouk' ? [present] : [present, missing];
      return { items, total: items.length };
    });
    api({
      listVideos,
      listFacets: async () => ({
        ...emptyFacets,
        styles: [{ id: 'builtin:zouk', name: 'Zouk' }],
        instructors: [{ id: 'aline', name: 'Aline' }],
        tags: [{ id: 'wave', name: 'body wave' }],
      }),
    });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'lesson-basic.mp4' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'gone.mp4' })).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'zouk' },
    });
    await waitFor(() =>
      expect(listVideos).toHaveBeenCalledWith(expect.objectContaining({ text: 'zouk' })),
    );
    expect(screen.queryByRole('heading', { name: 'gone.mp4' })).toBeNull();

    fireEvent.change(screen.getByRole('combobox', { name: 'Style' }), {
      target: { value: 'builtin:zouk' },
    });
    await waitFor(() =>
      expect(listVideos).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'zouk', styleIds: ['builtin:zouk'] }),
      ),
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Instructor' }), {
      target: { value: 'aline' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Level' }), {
      target: { value: 'Intermediate' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Type' }), {
      target: { value: 'lesson' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Tag' }), {
      target: { value: 'wave' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Favorites' }));
    await waitFor(() =>
      expect(listVideos).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'zouk',
          styleIds: ['builtin:zouk'],
          instructorIds: ['aline'],
          levels: ['Intermediate'],
          videoTypes: ['lesson'],
          tagIds: ['wave'],
          favorite: true,
        }),
      ),
    );
  });

  it('returns to the first page when a filter changes', async () => {
    const listVideos = vi.fn(async (query: unknown) => {
      void query;
      return { items: [present, missing], total: 96 };
    });
    api({ listVideos });
    render(<App />);
    await screen.findByRole('heading', { name: 'lesson-basic.mp4' });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(listVideos).toHaveBeenCalledWith(expect.objectContaining({ offset: 48 })),
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Favorites' }));
    await waitFor(() =>
      expect(listVideos).toHaveBeenLastCalledWith(
        expect.objectContaining({ favorite: true, offset: 0 }),
      ),
    );
  });

  it('returns to the first page when refresh drops a missing facet', async () => {
    let facetCalls = 0;
    const listVideos = vi.fn(async (query: unknown) => {
      void query;
      return { items: [present, missing], total: 96 };
    });
    api({
      listVideos,
      listFacets: async () => {
        facetCalls += 1;
        return facetCalls === 1 ? emptyFacets : { ...emptyFacets, libraries: [] };
      },
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'lesson-basic.mp4' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Source' }), {
      target: { value: 'lib' },
    });
    await waitFor(() =>
      expect(listVideos).toHaveBeenLastCalledWith(
        expect.objectContaining({ libraryIds: ['lib'], offset: 0 }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(listVideos).toHaveBeenLastCalledWith(
        expect.objectContaining({ libraryIds: ['lib'], offset: 48 }),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Rescan dance' }));
    await waitFor(() => {
      const lastQuery = listVideos.mock.calls.at(-1)?.[0];
      expect(lastQuery).toEqual(expect.objectContaining({ offset: 0 }));
      expect(lastQuery).not.toHaveProperty('libraryIds');
    });
  });

  it('clears a failed load after a later search succeeds', async () => {
    let fail = true;
    api({
      listVideos: async (query) => {
        if (fail) throw new Error('SQLITE_BUSY');
        const items = query?.text ? [present] : [present, missing];
        return { items, total: items.length };
      },
    });
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'SQLITE_BUSY');
    fail = false;
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'zouk' },
    });
    expect(await screen.findByRole('heading', { name: 'lesson-basic.mp4' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not let an older page replace a newer search', async () => {
    let resolveFirst: (page: { items: VideoListItem[]; total: number }) => void = () => {};
    api({
      listVideos: (query) => {
        if (query?.text === 'bolero') return Promise.resolve({ items: [present], total: 1 });
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      },
    });
    render(<App />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'bolero' },
    });
    expect(await screen.findByRole('heading', { name: 'lesson-basic.mp4' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'gone.mp4' })).toBeNull();
    resolveFirst({ items: [present, missing], total: 2 });
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'gone.mp4' })).toBeNull();
    });
  });

  it('shows an empty catalog', async () => {
    api({
      listLibraries: async () => [],
      listVideos: async () => ({ items: [], total: 0 }),
    });
    render(<App />);
    expect(await screen.findByText(/No videos yet/)).toBeTruthy();
  });

  it('shows database and ffprobe failures', async () => {
    api({
      getHealth: async () => ({
        ...health,
        database: { ok: false, schemaVersion: 0, path: '/tmp/catalog.sqlite', error: 'disk full' },
        ffprobe: { ok: false, version: null, error: 'not found' },
      }),
    });
    render(<App />);
    expect(
      await screen.findByText('Database failed: disk full · ffprobe failed: not found'),
    ).toBeTruthy();
  });

  it('shows an alert when the preload API is missing', async () => {
    window.danceLibrary = undefined;
    render(<App />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/preload/i);
  });

  it('shows an alert when the health check rejects', async () => {
    const notify = api({
      getHealth: async () => {
        throw new Error('IPC down');
      },
    });
    render(<App />);
    expect((await screen.findByRole('alert')).textContent).toBe('IPC down');
    await waitFor(() => expect(notify).toHaveBeenCalled());
  });
});
