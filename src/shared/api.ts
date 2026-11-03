export const IpcChannels = {
  getHealth: 'app:get-health',
  healthShown: 'app:health-shown',
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

/** The only bridge the renderer is allowed to use. */
export type DanceLibraryApi = {
  getHealth: () => Promise<AppHealth>;
  /** No-op unless the main process was started with DANCE_LIBRARY_SCREENSHOT. */
  notifyHealthShown: () => Promise<void>;
};
