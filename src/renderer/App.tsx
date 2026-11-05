import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AddLibrariesResult,
  AppHealth,
  CatalogFacets,
  DanceLibraryApi,
  LibrarySummary,
  ScanProgress,
  VideoCounts,
  VideoListItem,
  VideoQuery,
} from '../shared/api';
import { formatVideoMeta } from '../shared/format';
import type { BrowseFilters } from '../shared/search';
import {
  emptyBrowseFilters,
  filtersAreActive,
  toVideoQuery,
  videoTypeLabels,
} from '../shared/search';
import { FilterBar } from './FilterBar';

type ViewMode = 'grid' | 'list';
type CatalogView = 'library' | 'excluded';

export function App() {
  const api = window.danceLibrary;
  if (!api) {
    return (
      <main className="fallback">
        <h1>Dance Library</h1>
        <p role="alert">Preload API is unavailable</p>
      </main>
    );
  }
  return <LibraryScreen api={api} />;
}

function LibraryScreen({ api }: { api: DanceLibraryApi }) {
  const [health, setHealth] = useState<AppHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [libraries, setLibraries] = useState<LibrarySummary[] | null>(null);
  const [videos, setVideos] = useState<VideoListItem[] | null>(null);
  const [counts, setCounts] = useState<VideoCounts>({ visible: 0, excluded: 0 });
  const [facets, setFacets] = useState<CatalogFacets>({
    styles: [],
    instructors: [],
    tags: [],
    libraries: [],
  });
  const [filters, setFilters] = useState<BrowseFilters>(emptyBrowseFilters);
  const [catalogView, setCatalogView] = useState<CatalogView>('library');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<ViewMode>('grid');
  const notified = useRef(false);
  const query = useMemo(
    () => toVideoQuery(filters, catalogView === 'excluded'),
    [filters, catalogView],
  );
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    let active = true;
    api
      .getHealth()
      .then((result) => {
        if (active) setHealth(result);
      })
      .catch((caught: unknown) => {
        if (active) setHealthError(messageOf(caught));
      });
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    let active = true;
    loadCatalog(api, query)
      .then((result) => {
        if (!active) return;
        applyCatalog(result, setLibraries, setVideos, setCounts, setFacets, setSelected);
      })
      .catch((caught: unknown) => {
        if (active) setLoadError(messageOf(caught));
      });
    return () => {
      active = false;
    };
  }, [api, query]);

  useEffect(() => {
    return api.onScanProgress((next) => setProgress(next));
  }, [api]);

  useEffect(() => {
    if (notified.current || busy) return;
    if (!libraries || !videos) return;
    if (!health && !healthError) return;
    notified.current = true;
    void api.notifyViewReady();
  }, [api, busy, libraries, videos, health, healthError]);

  async function reload(): Promise<void> {
    const result = await loadCatalog(api, queryRef.current);
    applyCatalog(result, setLibraries, setVideos, setCounts, setFacets, setSelected);
  }

  async function runTask(task: () => Promise<void>): Promise<void> {
    setBusy(true);
    setLoadError(null);
    try {
      await task();
      await reload();
    } catch (caught) {
      setLoadError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function onAdd(): Promise<void> {
    setNotice(null);
    await runTask(async () => {
      const result = await api.addLibraries();
      setNotice(skippedMessage(result));
    });
  }

  async function onScan(libraryId: string): Promise<void> {
    setNotice(null);
    await runTask(async () => {
      await api.scanLibrary(libraryId);
    });
  }

  async function onScanAll(): Promise<void> {
    setNotice(null);
    await runTask(async () => {
      await api.scanAll();
    });
  }

  async function onRemove(libraryId: string): Promise<void> {
    setNotice(null);
    await runTask(async () => {
      const result = await api.removeLibrary(libraryId);
      if (!result.ok && result.message !== 'Cancelled.') setNotice(result.message);
    });
  }

  function showCatalog(view: CatalogView): void {
    setCatalogView(view);
    setLoadError(null);
  }

  function toggleOne(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll(ids: readonly string[]): void {
    setSelected((current) => (current.size === ids.length ? new Set() : new Set(ids)));
  }

  async function onExclude(): Promise<void> {
    const ids = [...selected];
    if (ids.length === 0) return;
    await runTask(async () => {
      const result = await api.excludeVideos(ids);
      if (result.changed < result.requested) {
        setNotice(
          `${result.requested - result.changed} selected videos were already merged or removed.`,
        );
      }
    });
  }

  async function onRestore(): Promise<void> {
    const ids = [...selected];
    if (ids.length === 0) return;
    await runTask(async () => {
      await api.restoreVideos(ids);
    });
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <h1>Dance Library</h1>
          <p className="lede">Videos stay where they are. This catalog stores references only.</p>
        </div>
        <button type="button" onClick={() => void onAdd()} disabled={busy}>
          Add folder
        </button>
      </header>
      <div className="body">
        <aside className="sidebar">
          <div className="sidebar-head">
            <h2>Folders</h2>
            <button
              type="button"
              onClick={() => void onScanAll()}
              disabled={busy || !libraries?.length}
            >
              Rescan all
            </button>
          </div>
          {libraries === null ? <p role="status">Loading the catalog…</p> : null}
          {libraries && libraries.length === 0 ? (
            <p>Add a folder on this computer or on a drive you plug in.</p>
          ) : null}
          <ul className="folder-list">
            {libraries?.map((library) => (
              <li key={library.id}>
                <p className="folder-name">{library.label}</p>
                <p className="folder-path">{library.path}</p>
                <p className="folder-meta">
                  {library.availability === 'offline' ? 'Offline' : 'Online'}
                  {' · '}
                  {library.videoCount} {library.videoCount === 1 ? 'video' : 'videos'}
                  {library.missingCount > 0 ? ` · ${library.missingCount} missing` : ''}
                </p>
                {library.lastError ? <p className="folder-error">{library.lastError}</p> : null}
                <div className="folder-actions">
                  <button
                    type="button"
                    onClick={() => void onScan(library.id)}
                    disabled={busy}
                    aria-label={`Rescan ${library.label}`}
                  >
                    Rescan
                  </button>
                  <button
                    type="button"
                    onClick={() => void onRemove(library.id)}
                    disabled={busy}
                    aria-label={`Remove ${library.label}`}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </aside>
        <section className="catalog" aria-label="Videos">
          <div className="catalog-head">
            <h2>{heading(videos, counts, catalogView)}</h2>
            <div className="view-toggle" role="group" aria-label="Catalog">
              <button
                type="button"
                aria-pressed={catalogView === 'library'}
                onClick={() => showCatalog('library')}
              >
                Library
              </button>
              <button
                type="button"
                aria-pressed={catalogView === 'excluded'}
                onClick={() => showCatalog('excluded')}
              >
                Excluded{counts.excluded > 0 ? ` (${counts.excluded})` : ''}
              </button>
            </div>
            <div className="view-toggle" role="group" aria-label="Layout">
              <button type="button" aria-pressed={view === 'grid'} onClick={() => setView('grid')}>
                Grid
              </button>
              <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>
                List
              </button>
            </div>
          </div>
          {progress ? (
            <div className="scan">
              {progress.state === 'running' ? (
                <progress
                  value={progress.completed}
                  max={Math.max(progress.discovered, 1)}
                  aria-label="Scan progress"
                />
              ) : null}
              <p role="status">{progress.message}</p>
            </div>
          ) : null}
          {notice ? <p role="status">{notice}</p> : null}
          <FilterBar facets={facets} value={filters} onChange={setFilters} />
          {loadError ? <p role="alert">{loadError}</p> : null}
          {videos === null && !loadError ? <p role="status">Checking the runtime…</p> : null}
          {videos && videos.length > 0 ? (
            <div className="selection-bar">
              <label>
                <input
                  type="checkbox"
                  checked={selected.size === videos.length}
                  onChange={() => toggleAll(videos.map((video) => video.id))}
                />
                Select all
              </label>
              {catalogView === 'library' ? (
                <button
                  type="button"
                  onClick={() => void onExclude()}
                  disabled={busy || selected.size === 0}
                >
                  Remove from library{selected.size > 0 ? ` (${selected.size})` : ''}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void onRestore()}
                  disabled={busy || selected.size === 0}
                >
                  Restore{selected.size > 0 ? ` (${selected.size})` : ''}
                </button>
              )}
            </div>
          ) : null}
          {videos && videos.length === 0 ? (
            <p className="empty">
              {filtersAreActive(filters)
                ? 'No videos match this search.'
                : catalogView === 'excluded'
                  ? 'Nothing is excluded. Removed videos show up here and can be restored.'
                  : 'No videos yet. Add a folder and the scan will fill this list.'}
            </p>
          ) : null}
          {videos && videos.length > 0 ? (
            <ul className={view === 'grid' ? 'video-grid' : 'video-list'}>
              {videos.map((video) => (
                <VideoCard
                  key={video.id}
                  video={video}
                  selected={selected.has(video.id)}
                  onToggle={() => toggleOne(video.id)}
                />
              ))}
            </ul>
          ) : null}
        </section>
      </div>
      <footer>
        <p className="policy">
          References only. This app never moves, modifies, or deletes video files.
        </p>
        <p className={healthError ? 'bad' : 'runtime'}>{runtimeLine(health, healthError)}</p>
        {healthError ? <p role="alert">{healthError}</p> : null}
      </footer>
    </div>
  );
}

function VideoCard({
  video,
  selected,
  onToggle,
}: {
  video: VideoListItem;
  selected: boolean;
  onToggle: () => void;
}) {
  const copies = video.locations.length;
  const details = catalogDetails(video);
  return (
    <li className={video.presence === 'missing' ? 'video missing' : 'video'}>
      <label className="select-video">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${video.displayTitle}`}
        />
      </label>
      {video.thumbnailUrl ? (
        <img src={video.thumbnailUrl} alt={`${video.displayTitle} thumbnail`} />
      ) : (
        <div className="thumb-fallback" aria-hidden="true">
          No preview
        </div>
      )}
      <div className="video-copy">
        <h3>{video.displayTitle}</h3>
        <p>{formatVideoMeta(video)}</p>
        {details ? <p>{details}</p> : null}
        {video.tags.length > 0 ? <p className="video-tags">{video.tags.join(' · ')}</p> : null}
        {video.favorite ? <p className="favorite">Favorite</p> : null}
        <p className="video-source">
          {copies > 1 ? `${copies} copies` : (video.locations[0]?.libraryLabel ?? 'No copies')}
          {video.presence === 'missing' ? ' · Missing' : ''}
        </p>
        {copies > 1 ? (
          <ul className="copy-list">
            {video.locations.map((location) => (
              <li key={location.id}>
                {location.presence === 'missing' ? 'Missing' : 'Online'} · {location.path}
              </li>
            ))}
          </ul>
        ) : null}
        {video.metadataError ? <p className="video-error">{video.metadataError}</p> : null}
      </div>
    </li>
  );
}

function heading(
  videos: VideoListItem[] | null,
  counts: VideoCounts,
  catalogView: CatalogView,
): string {
  if (!videos) return 'Videos';
  const total = catalogView === 'excluded' ? counts.excluded : counts.visible;
  const noun = videos.length === 1 ? 'video' : 'videos';
  if (videos.length === total) return `${videos.length} ${noun}`;
  const totalNoun = total === 1 ? 'video' : 'videos';
  return `${videos.length} of ${total} ${totalNoun}`;
}

function catalogDetails(video: VideoListItem): string | null {
  const parts = [
    video.videoType ? videoTypeLabels[video.videoType] : null,
    video.styleName,
    video.level,
    video.instructors.length > 0 ? video.instructors.join(', ') : null,
  ].filter((part): part is string => part != null && part.length > 0);
  return parts.length > 0 ? parts.join(' · ') : null;
}

async function loadCatalog(api: DanceLibraryApi, query: VideoQuery) {
  const [libraries, videos, counts, facets] = await Promise.all([
    api.listLibraries(),
    api.listVideos(query),
    api.countVideos(),
    api.listFacets(),
  ]);
  return { libraries, videos, counts, facets };
}

function applyCatalog(
  result: Awaited<ReturnType<typeof loadCatalog>>,
  setLibraries: (libraries: LibrarySummary[]) => void,
  setVideos: (videos: VideoListItem[]) => void,
  setCounts: (counts: VideoCounts) => void,
  setFacets: (facets: CatalogFacets) => void,
  setSelected: (selected: ReadonlySet<string>) => void,
): void {
  setLibraries(result.libraries);
  setVideos(result.videos);
  setCounts(result.counts);
  setFacets(result.facets);
  setSelected(new Set());
}

function runtimeLine(health: AppHealth | null, healthError: string | null): string {
  if (healthError) return `Runtime check failed: ${healthError}`;
  if (!health) return 'Checking the runtime…';
  const database = health.database.ok
    ? `Database schema ${health.database.schemaVersion}`
    : `Database failed: ${health.database.error ?? 'unknown error'}`;
  const ffprobe = health.ffprobe.ok
    ? `ffprobe ${health.ffprobe.version}`
    : `ffprobe failed: ${health.ffprobe.error}`;
  return `${database} · ${ffprobe}`;
}

function skippedMessage(result: AddLibrariesResult): string | null {
  if (result.skipped.length === 0) return null;
  return result.skipped.map((item) => item.message).join(' ');
}

function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
