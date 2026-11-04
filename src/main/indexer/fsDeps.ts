import fs from 'node:fs';
import path from 'node:path';
import { fullContentHash, partialContentHash, partialHashCoversFile } from './contentHash';
import { probeVideo } from './ffprobe';
import type { IndexedStat, ScanDeps } from './scan';
import { writeThumbnail } from './thumbnails';
import { directoryReadable, walkVideos } from './walk';
import { describePath, listMounts, type Mount } from './volumes';

/** Real filesystem, ffprobe, and ffmpeg. Video files are opened read-only. */
export function createScanDeps(thumbsDir: string): ScanDeps {
  let mounts: Mount[] | null = null;
  return {
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
    readDirectory: directoryReadable,
    walkVideos,
    stat: async (filePath) => statIndexedFile(filePath, mounts ?? (mounts = await listMounts())),
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
}

export async function statIndexedFile(
  filePath: string,
  mounts: readonly Mount[],
): Promise<IndexedStat> {
  const stat = await fs.promises.stat(filePath, { bigint: true });
  const size = Number(stat.size);
  if (!Number.isSafeInteger(size)) throw new Error('File is too large to catalog');
  const location = describePath(filePath, mounts);
  return {
    size,
    mtimeNs: stat.mtimeNs.toString(),
    mtime: new Date(Number(stat.mtimeNs / 1_000_000n)),
    birthtime: stat.birthtimeNs > 0n ? new Date(Number(stat.birthtimeNs / 1_000_000n)) : null,
    fileId: stat.ino > 0n ? stat.ino.toString(10) : null,
    volumeId: location?.volumeId ?? null,
  };
}
