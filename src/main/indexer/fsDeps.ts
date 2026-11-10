import fs from 'node:fs';
import path from 'node:path';
import { fullContentHash, partialContentHash, partialHashCoversFile } from './contentHash';
import { probeVideo } from './ffprobe';
import type { IndexedStat, ScanDeps } from './scan';
import { writeThumbnail } from './thumbnails';
import { directoryReadable, walkVideos } from './walk';
import {
  describePath,
  fileIdIsStable,
  isStableVolumeId,
  listMounts,
  windowsVolumeIdFromSerial,
  type Mount,
} from './volumes';
import { walkLibrary } from './walk';

/** Real filesystem, ffprobe, and ffmpeg. Video files are opened read-only. */
export function createScanDeps(thumbsDir: string): ScanDeps {
  let mounts: Mount[] | null = null;
  const deps: ScanDeps = {
    listMounts: async () => {
      mounts = await listMounts();
      return mounts;
    },
    describePath,
    isDirectory(filePath) {
      try {
        return fs.statSync(filePath).isDirectory();
      } catch {
        return false;
      }
    },
    exists(filePath) {
      try {
        fs.accessSync(filePath, fs.constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    sameFilePathAlias: async (left, right) => {
      try {
        return (await fs.promises.realpath(left)) === (await fs.promises.realpath(right));
      } catch {
        return false;
      }
    },
    readDirectory: directoryReadable,
    directoryHasEntries: directoryHasEntries,
    walkVideos,
    walkLibrary,
    stat: async (filePath) => {
      if (!mounts) mounts = await deps.listMounts();
      return statIndexedFile(filePath, mounts);
    },
    hash: async (filePath) => {
      const hashed = await partialContentHash(filePath);
      return { hash: hashed.hash, kind: hashed.kind };
    },
    hashCoversFile: partialHashCoversFile,
    fullHash: fullContentHash,
    probe: probeVideo,
    writeThumbnail,
    thumbnailExists(fileName) {
      return fs.existsSync(path.join(thumbsDir, fileName));
    },
    now: () => new Date().toISOString(),
  };
  return deps;
}

const ROOT_LITTER = new Set([
  '$recycle.bin',
  'recycler',
  'found.000',
  'thumbs.db',
  'desktop.ini',
  '.ds_store',
  '.trashes',
  '.spotlight-v100',
  'system volume information',
  'lost+found',
]);

export function isRootLitter(name: string): boolean {
  if (name.startsWith('.')) return true;
  return ROOT_LITTER.has(name.toLowerCase());
}

/** Reads one real entry. System junk does not count. Null means the folder could not be read. */
export async function directoryHasEntries(dir: string): Promise<boolean | null> {
  let handle: fs.Dir | undefined;
  try {
    handle = await fs.promises.opendir(dir);
    for await (const entry of handle) {
      if (!isRootLitter(entry.name)) return true;
    }
    return false;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function statIndexedFile(
  filePath: string,
  mounts: readonly Mount[],
): Promise<IndexedStat> {
  const stat = await fs.promises.stat(filePath, { bigint: true });
  const size = Number(stat.size);
  if (!Number.isSafeInteger(size)) throw new Error('File is too large to catalog');
  const location = describePath(filePath, mounts);
  let volumeId = isStableVolumeId(location?.volumeId) ? location.volumeId : null;
  // Windows reports the volume serial on stat.dev even when the mount listing failed.
  if (!volumeId && process.platform === 'win32' && stat.dev > 0n) {
    volumeId = windowsVolumeIdFromSerial(stat.dev);
  }
  return {
    size,
    mtimeNs: stat.mtimeNs.toString(),
    mtime: new Date(Number(stat.mtimeNs / 1_000_000n)),
    birthtime: stat.birthtimeNs > 0n ? new Date(Number(stat.birthtimeNs / 1_000_000n)) : null,
    fileId: stat.ino > 0n ? stat.ino.toString(10) : null,
    volumeId,
    fileIdStable: fileIdIsStable(location?.fsType),
  };
}
