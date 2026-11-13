import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent, SetStateAction } from 'react';
import type {
  AddLibrariesResult,
  AppHealth,
  CatalogFacets,
  DanceLibraryApi,
  LibrarySummary,
  ScanProgress,
  VideoCounts,
  VideoListItem,
} from '../shared/api';
import { formatVideoMeta } from '../shared/format';
import type { BrowseFilters } from '../shared/search';
import {
  dropMissingFacets,
  emptyBrowseFilters,
  filtersAreActive,
  pageAfterShrink,
  toVideoQuery,
  videoPageSize,
  videoTypeLabels,
} from '../shared/search';
import { FilterBar } from './FilterBar';
import { DetailPanel } from './DetailPanel';

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
  const [{ filters, page }, setBrowse] = useState(() => ({
    filters: emptyBrowseFilters(),
    page: 0,
  }));
  const [matchTotal, setMatchTotal] = useState<number | null>(null);
  const [catalogView, setCatalogView] = useState<CatalogView>('library');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<ViewMode>('grid');
  const [editingIds, setEditingIds] = useState<string[] | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [editNotice, setEditNotice] = useState<{
    message: string;
    canUndo: boolean;
    token?: string;
  } | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  const [editorVersion, setEditorVersion] = useState(0);
  const selectionAnchor = useRef<number>(-1);
  const selectionExtent = useRef<number>(-1);
  const listRef = useRef<HTMLUListElement>(null);
  const editNoticeRef = useRef<HTMLDivElement>(null);
  const scanBusyRef = useRef(false);
  scanBusyRef.current = busy;
  const notified = useRef(false);
  const listSeq = useRef(0);
  const metaSeq = useRef(0);
  const debouncedText = useDebounced(filters.text, 150);
  const filterKey = JSON.stringify({
    catalogView,
    filters: { ...filters, text: debouncedText },
  });
  const query = useMemo(() => {
    const next = toVideoQuery({ ...filters, text: debouncedText }, catalogView === 'excluded');
    next.offset = page * videoPageSize;
    return next;
    // filterKey replaces the live search text with its debounced value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, page]);

  function setPage(next: SetStateAction<number>): void {
    setBrowse((current) => ({
      ...current,
      page: typeof next === 'function' ? next(current.page) : next,
    }));
  }

  function setFiltersAndResetPage(next: SetStateAction<BrowseFilters>): void {
    setBrowse((current) => {
      const filtersNow = typeof next === 'function' ? next(current.filters) : next;
      if (filtersNow === current.filters) return current;
      return { filters: filtersNow, page: 0 };
    });
  }

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
    function key(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'z' &&
        !event.shiftKey &&
        !event.altKey &&
        !event.repeat
      ) {
        if (
          editorDirty ||
          (target instanceof Element &&
            (target.matches('input, textarea, select, [contenteditable=true]') ||
              target.closest('[role="combobox"][aria-expanded="true"]')))
        )
          return;
        event.preventDefault();
        void undoEdit();
        return;
      }
      if (editingIds || (target instanceof Element && target.closest('.detail-panel'))) return;
      if (
        target instanceof Element &&
        target.matches('input, textarea, select, [contenteditable=true]')
      )
        return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && videos) {
        event.preventDefault();
        setSelected(new Set(videos.map((v) => v.id)));
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key.toLowerCase() === 'e' && selected.size) {
        event.preventDefault();
        setEditingIds([...selected]);
      }
      if (event.key.toLowerCase() === 'f' && selected.size === 1) {
        event.preventDefault();
        const id = [...selected][0]!;
        void api
          .getVideoDetails(id)
          .then((d) => api.updateVideo(id, { favorite: !d.favorite }))
          .then(async (result) => {
            await reload([id]);
            if (result.undoToken)
              setEditNotice({
                message: `Saved favorite for ${result.displayTitle}`,
                canUndo: true,
                token: result.undoToken,
              });
            else setEditNotice(null);
          })
          .catch((caught: unknown) => setLoadError(messageOf(caught)));
      }
      if (
        ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(event.key) &&
        videos?.length
      ) {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
        const current =
          selectionExtent.current < 0 ? (delta > 0 ? -1 : videos.length) : selectionExtent.current;
        const next = Math.max(0, Math.min(videos.length - 1, current + delta));
        selectionExtent.current = next;
        if (event.shiftKey) {
          if (selectionAnchor.current < 0)
            selectionAnchor.current = current < 0 || current >= videos.length ? next : current;
          const low = Math.min(selectionAnchor.current, next),
            high = Math.max(selectionAnchor.current, next);
          setSelected(new Set(videos.slice(low, high + 1).map((v) => v.id)));
        } else {
          selectionAnchor.current = next;
          setSelected(new Set([videos[next]!.id]));
        }
        queueMicrotask(() =>
          listRef.current?.querySelector<HTMLElement>(`[data-video-index="${next}"]`)?.focus(),
        );
      }
    }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
    // reload intentionally reads the latest query and is recreated during render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, editingIds, editorDirty, selected, videos]);

  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    let active = true;
    const metadataSeq = ++metaSeq.current;
    Promise.all([
      api.listLibraries(),
      api.countVideos(),
      api.listFacets({ excluded: catalogView === 'excluded' }),
    ])
      .then(([nextLibraries, nextCounts, nextFacets]) => {
        if (!active || metadataSeq !== metaSeq.current) return;
        setLibraries(nextLibraries);
        setCounts(nextCounts);
        setFacets(nextFacets);
        setFiltersAndResetPage((current) => dropMissingFacets(current, nextFacets));
      })
      .catch((caught: unknown) => {
        if (active && metadataSeq === metaSeq.current) setLoadError(messageOf(caught));
      });
    return () => {
      active = false;
    };
  }, [api, catalogView]);

  useEffect(() => {
    const seq = ++listSeq.current;
    api
      .listVideos(query)
      .then((result) => {
        if (seq !== listSeq.current) return;
        setVideos(result.items);
        setMatchTotal(result.total);
        setLoadError(null);
        setSelected(new Set());
        selectionAnchor.current = -1;
        selectionExtent.current = -1;
        const nextPage = pageAfterShrink(page, result.total, videoPageSize);
        if (result.items.length === 0 && nextPage != null) setPage(nextPage);
      })
      .catch((caught: unknown) => {
        if (seq !== listSeq.current) return;
        setLoadError(messageOf(caught));
      });
  }, [api, query, page]);

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

  async function reload(preserveIds: readonly string[] = []): Promise<void> {
    const seq = ++listSeq.current;
    const metadataSeq = ++metaSeq.current;
    const current = queryRef.current;
    const [nextLibraries, nextCounts, nextFacets, pageResult] = await Promise.all([
      api.listLibraries(),
      api.countVideos(),
      api.listFacets({ excluded: current.excluded === true }),
      api.listVideos(current),
    ]);
    if (metadataSeq === metaSeq.current) {
      setLibraries(nextLibraries);
      setCounts(nextCounts);
      setFacets(nextFacets);
      setFiltersAndResetPage((filtersNow) => dropMissingFacets(filtersNow, nextFacets));
    }
    if (seq !== listSeq.current) return;
    setVideos(pageResult.items);
    setMatchTotal(pageResult.total);
    setLoadError(null);
    const kept = preserveIds.filter((id) => pageResult.items.some((item) => item.id === id));
    setSelected(new Set(kept));
    const keptIndex = kept.length
      ? pageResult.items.findIndex((item) => item.id === kept.at(-1))
      : -1;
    selectionAnchor.current = keptIndex;
    selectionExtent.current = keptIndex;
    const sentPage = Math.floor((current.offset ?? 0) / videoPageSize);
    const nextPage = pageAfterShrink(sentPage, pageResult.total, videoPageSize);
    if (pageResult.items.length === 0 && nextPage != null) setPage(nextPage);
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
    setPage(0);
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

  function selectVideo(id: string, index: number, event: MouseEvent): void {
    if (event.shiftKey && videos) {
      const from = Math.min(selectionAnchor.current, index),
        to = Math.max(selectionAnchor.current, index);
      setSelected(new Set(videos.slice(from, to + 1).map((v) => v.id)));
    } else if (event.ctrlKey || event.metaKey) toggleOne(id);
    else setSelected(new Set([id]));
    selectionAnchor.current = index;
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

  async function undoEdit(token?: string): Promise<void> {
    if (editorDirty || scanBusyRef.current || undoBusy) return;
    setUndoBusy(true);
    setLoadError(null);
    try {
      const result = await api.undoLastEdit(token);
      if (!result) {
        setEditNotice({ message: 'Nothing to undo', canUndo: false });
        return;
      }
      if (result.status === 'stale') {
        setEditNotice({
          message: 'That save is no longer the latest edit and cannot be undone here.',
          canUndo: false,
        });
        return;
      }
      await reload(editingIds ?? [...selected]);
      if (editingIds) setEditorVersion((value) => value + 1);
      const suffix = `${result.skipped ? ` · ${result.skipped} unavailable` : ''}${result.conflicts ? ` · ${result.conflicts} conflicts` : ''}`;
      setEditNotice({
        message:
          result.restored === 1 && result.title
            ? `Undid edit to ${result.title}${suffix}`
            : `Undid edit to ${result.restored} ${result.restored === 1 ? 'video' : 'videos'}${suffix}`,
        canUndo: result.canUndo,
        token: result.undoToken,
      });
      queueMicrotask(() => editNoticeRef.current?.focus());
    } catch (caught) {
      setLoadError(messageOf(caught));
    } finally {
      setUndoBusy(false);
    }
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
            <h2>{heading(matchTotal, counts, catalogView, filtersAreActive(filters))}</h2>
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
          {editNotice ? (
            <div
              ref={editNoticeRef}
              tabIndex={-1}
              role="status"
              aria-live="polite"
              className="edit-notice"
            >
              <span>{editNotice.message}</span>
              {editNotice.canUndo ? (
                <>
                  <span aria-hidden="true"> · </span>
                  <button
                    type="button"
                    disabled={busy || undoBusy || editorDirty}
                    onClick={() => void undoEdit(editNotice.token)}
                  >
                    Undo
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
          <FilterBar
            facets={facets}
            value={filters}
            onChange={(next) => {
              setFiltersAndResetPage(next);
            }}
          />
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
                <>
                  <button
                    type="button"
                    onClick={() => setEditingIds([...selected])}
                    disabled={selected.size === 0}
                  >
                    Edit{selected.size > 1 ? ` (${selected.size})` : ''}
                  </button>
                  <button
                    type="button"
                    onClick={() => void onExclude()}
                    disabled={busy || selected.size === 0}
                  >
                    Remove from library{selected.size > 0 ? ` (${selected.size})` : ''}
                  </button>
                </>
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
          {matchTotal != null && matchTotal > videoPageSize ? (
            <div className="pager">
              <button
                type="button"
                onClick={() => setPage((current) => current - 1)}
                disabled={page === 0}
              >
                Previous
              </button>
              <span>
                Showing {page * videoPageSize + 1}–
                {Math.min(matchTotal, (page + 1) * videoPageSize)} of {matchTotal}
              </span>
              <button
                type="button"
                onClick={() => setPage((current) => current + 1)}
                disabled={(page + 1) * videoPageSize >= matchTotal}
              >
                Next
              </button>
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
            <ul
              ref={listRef}
              role="listbox"
              aria-multiselectable="true"
              className={view === 'grid' ? 'video-grid' : 'video-list'}
            >
              {videos.map((video, index) => (
                <VideoCard
                  key={video.id}
                  video={video}
                  selected={selected.has(video.id)}
                  index={index}
                  onToggle={() => toggleOne(video.id)}
                  onSelect={(event) => selectVideo(video.id, index, event)}
                />
              ))}
            </ul>
          ) : null}
        </section>
      </div>
      {editingIds ? (
        <DetailPanel
          key={`${editingIds.join(',')}:${editorVersion}`}
          api={api}
          ids={editingIds}
          onClose={() => {
            setEditorDirty(false);
            setEditingIds(null);
            queueMicrotask(() =>
              listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus(),
            );
          }}
          onDirtyChange={setEditorDirty}
          onSaved={async (count, token) => {
            await reload(editingIds);
            setEditNotice({
              message: `Saved ${count} ${count === 1 ? 'video' : 'videos'}`,
              canUndo: true,
              token,
            });
          }}
        />
      ) : null}
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
  index,
  onToggle,
  onSelect,
}: {
  video: VideoListItem;
  selected: boolean;
  index: number;
  onToggle: () => void;
  onSelect: (event: MouseEvent) => void;
}) {
  const copies = video.locations.length;
  const details = catalogDetails(video);
  return (
    <li
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-video-index={index}
      className={`${video.presence === 'missing' ? 'video missing' : 'video'}${selected ? ' selected' : ''}`}
      onClick={onSelect}
    >
      <label className="select-video">
        <input
          type="checkbox"
          checked={selected}
          onClick={(event) => event.stopPropagation()}
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
  matchTotal: number | null,
  counts: VideoCounts,
  catalogView: CatalogView,
  filtered: boolean,
): string {
  if (matchTotal == null) return 'Videos';
  const noun = matchTotal === 1 ? 'video' : 'videos';
  const libraryTotal = catalogView === 'excluded' ? counts.excluded : counts.visible;
  if (!filtered || matchTotal === libraryTotal) return `${matchTotal} ${noun}`;
  const totalNoun = libraryTotal === 1 ? 'video' : 'videos';
  return `${matchTotal} of ${libraryTotal} ${totalNoun}`;
}

function useDebounced(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (value === debounced) return;
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs, debounced]);
  return debounced;
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
