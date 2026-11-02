import type { AppHealth, DatabaseHealth, FfprobeHealth } from '../shared/api';
import { autoUpdateStatus } from './autoUpdate';
import { probeBundledFfprobe } from './binaries';
import { catalogPath, openCatalog, readDatabaseHealth } from './db/catalog';

export async function collectHealth(appVersion: string, userDataDir: string): Promise<AppHealth> {
  const dbPath = catalogPath(userDataDir);
  const ffprobePromise = probeBundledFfprobe();
  const database = openDatabaseHealth(dbPath);
  const ffprobe = toFfprobeHealth(await ffprobePromise);
  return {
    appVersion,
    database,
    ffprobe,
    autoUpdate: autoUpdateStatus,
  };
}

function openDatabaseHealth(dbPath: string): DatabaseHealth {
  try {
    const db = openCatalog(dbPath);
    try {
      return readDatabaseHealth(db, dbPath);
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      ok: false,
      schemaVersion: 0,
      path: dbPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function toFfprobeHealth(result: Awaited<ReturnType<typeof probeBundledFfprobe>>): FfprobeHealth {
  if (result.ok) return { ok: true, version: result.version };
  return { ok: false, version: result.version, error: result.error };
}
