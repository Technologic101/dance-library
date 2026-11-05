// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppHealth, CatalogFacets, LibrarySummary, VideoListItem } from '../shared/api';
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

function api(overrides: Partial<NonNullable<typeof window.danceLibrary>> = {}) {
  const notify = vi.fn(async () => {});
  window.danceLibrary = {
    getHealth: async () => health,
    notifyViewReady: notify,
    listLibraries: async () => [library],
    listVideos: async () => [present, missing],
    listFacets: async () => emptyFacets,
    countVideos: async () => ({ visible: 2, excluded: 0 }),
    excludeVideos: async () => ({ changed: 1, requested: 1 }),
    restoreVideos: async () => ({ changed: 1, requested: 1 }),
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
    expect(screen.getByText('0:02 · 640x360 · h264 · 2024-06-01 15:04:05 · 120 KB')).toBeTruthy();
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

  it('filters the catalog from the search box', async () => {
    const listVideos = vi.fn(async (query) => {
      if (query?.text === 'zouk') return [present];
      return [present, missing];
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

  it('shows an empty catalog', async () => {
    api({
      listLibraries: async () => [],
      listVideos: async () => [],
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
