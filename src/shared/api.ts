export const IpcChannels = {
  getHealth: 'app:get-health',
  viewReady: 'app:view-ready',
  listLibraries: 'library:list',
  addLibraries: 'library:add',
  removeLibrary: 'library:remove',
  scanLibrary: 'library:scan',
  scanAll: 'library:scan-all',
  listVideos: 'video:list',
  listFacets: 'catalog:facets',
  countVideos: 'video:count',
  excludeVideos: 'video:exclude',
  restoreVideos: 'video:restore',
  scanProgress: 'library:scan-progress',
} as const;

export type DatabaseHealth = {
  ok: boolean;
  schemaVersion: number;
  path: string;
  error?: string;
};

export type FfprobeHealth =
  { ok: true; version: string } | { ok: false; version: string | null; error: string };

export type AppHealth = {
  appVersion: string;
  database: DatabaseHealth;
  ffprobe: FfprobeHealth;
  autoUpdate: 'disabled';
};

export type CaptureDateSource = 'metadata' | 'filename' | 'file_time';

export const videoTypes = ['lesson', 'demo', 'social dance', 'performance'] as const;
export type VideoType = (typeof videoTypes)[number];

export const levels = ['Beginner', 'Intermediate', 'Advanced', 'Master', 'All levels'] as const;
export type Level = (typeof levels)[number];

export const videoSorts = [
  'newest',
  'oldest',
  'title',
  'title-desc',
  'longest',
  'shortest',
  'relevance',
] as const;
export type VideoSort = (typeof videoSorts)[number];

export type LibrarySummary = {
  id: string;
  path: string;
  label: string;
  availability: 'online' | 'offline';
  videoCount: number;
  missingCount: number;
  lastScannedAt: string | null;
  lastError: string | null;
};

export type VideoLocationItem = {
  id: string;
  libraryId: string;
  libraryLabel: string;
  path: string;
  filename: string;
  presence: 'present' | 'missing';
};

export type VideoListItem = {
  id: string;
  /** Custom title. Falls back to the filename until someone edits it. */
  title: string | null;
  displayTitle: string;
  videoType: VideoType | null;
  styleName: string | null;
  level: Level | null;
  favorite: boolean;
  instructors: string[];
  tags: string[];
  sizeBytes: number | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  capturedAt: string | null;
  capturedAtSource: CaptureDateSource | null;
  /** Present when any location is online. Missing when every location is gone. */
  presence: 'present' | 'missing';
  metadataError: string | null;
  thumbnailUrl: string | null;
  /** Hidden from the library until the user restores it. The files stay on disk. */
  excluded: boolean;
  locations: VideoLocationItem[];
};

export type VideoCounts = {
  visible: number;
  excluded: number;
};

export type VideoQuery = {
  excluded?: boolean;
  /** Matched against titles, notes, tags, and filenames. */
  text?: string;
  capturedFrom?: string;
  capturedTo?: string;
  videoTypes?: VideoType[];
  styleIds?: string[];
  instructorIds?: string[];
  levels?: Level[];
  /** A video must have every selected tag. */
  tagIds?: string[];
  libraryIds?: string[];
  durationMinMs?: number;
  durationMaxMs?: number;
  favorite?: boolean;
  sort?: VideoSort;
};

export type CatalogFacet = { id: string; name: string };

export type CatalogFacets = {
  styles: CatalogFacet[];
  instructors: CatalogFacet[];
  tags: CatalogFacet[];
  libraries: { id: string; label: string }[];
};

export type VideoChangeResult = {
  changed: number;
  requested: number;
};

export type ScanProgress = {
  state: 'running' | 'done' | 'error';
  libraryId: string | null;
  libraryLabel: string | null;
  discovered: number;
  completed: number;
  currentFile: string | null;
  message: string;
};

export type ScanSummary = {
  libraries: number;
  discovered: number;
  added: number;
  updated: number;
  unchanged: number;
  /** Extra copies attached to a video already in the catalog. */
  linked: number;
  missing: number;
  offline: number;
  errors: number;
};

export type SkippedFolder = {
  path: string;
  message: string;
};

export type AddLibrariesResult = {
  added: LibrarySummary[];
  skipped: SkippedFolder[];
  scan: ScanSummary | null;
};

export type RemoveLibraryResult = { ok: true } | { ok: false; message: string };

const THUMBNAIL_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/i;

/** Renderer URL for a thumbnail stored in the app-data folder. */
export function thumbnailUrl(fileName: string | null): string | null {
  if (!fileName || !THUMBNAIL_NAME.test(fileName)) return null;
  return `dance-thumb://thumbs/${fileName}`;
}

/** The only bridge the renderer is allowed to use. */
export type DanceLibraryApi = {
  getHealth: () => Promise<AppHealth>;
  /** No-op unless the main process was started with DANCE_LIBRARY_SCREENSHOT. */
  notifyViewReady: () => Promise<void>;
  listLibraries: () => Promise<LibrarySummary[]>;
  listVideos: (options?: VideoQuery) => Promise<VideoListItem[]>;
  listFacets: () => Promise<CatalogFacets>;
  countVideos: () => Promise<VideoCounts>;
  /** Opens a folder picker, then indexes each chosen folder. */
  addLibraries: () => Promise<AddLibrariesResult>;
  removeLibrary: (libraryId: string) => Promise<RemoveLibraryResult>;
  /** Hides catalog items. Does not delete or modify video files, and rescans keep them hidden. */
  excludeVideos: (videoIds: string[]) => Promise<VideoChangeResult>;
  restoreVideos: (videoIds: string[]) => Promise<VideoChangeResult>;
  scanLibrary: (libraryId: string) => Promise<ScanSummary>;
  scanAll: () => Promise<ScanSummary>;
  onScanProgress: (listener: (progress: ScanProgress) => void) => () => void;
};
