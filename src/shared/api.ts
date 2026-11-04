export const IpcChannels = {
  getHealth: 'app:get-health',
  viewReady: 'app:view-ready',
  listLibraries: 'library:list',
  addLibraries: 'library:add',
  removeLibrary: 'library:remove',
  scanLibrary: 'library:scan',
  scanAll: 'library:scan-all',
  listVideos: 'video:list',
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
  /** Custom title. Empty until a later phase edits it. */
  title: string | null;
  displayTitle: string;
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

export type VideoChangeResult = {
  changed: number;
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
  listVideos: (options?: { excluded?: boolean }) => Promise<VideoListItem[]>;
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
