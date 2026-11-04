import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { ScanProgress, ScanSummary } from '../../shared/api';
import { chooseCaptureDate } from './captureDate';
import { FULL_HASH_KIND } from './contentHash';
import { pathsEqual } from './paths';
import { clipError } from './process';
import {
  createRepository,
  type CatalogRepository,
  type LocationRecord,
  type VideoRecord,
} from './repository';
import { thumbnailFileName } from './thumbnails';
import { resolveLibraryPath, type Mount, type VolumeLocation } from './volumes';

export type IndexedStat = {
  size: number;
  mtimeNs: string;
  mtime: Date;
  birthtime: Date | null;
  fileId: string | null;
  volumeId: string | null;
};

export type ProbeFields = {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  metadataCreatedAt: string | null;
  error: string | null;
};

export type ScanDeps = {
  listMounts: () => Promise<Mount[]>;
  describePath: (filePath: string, mounts: readonly Mount[]) => VolumeLocation | null;
  isDirectory: (filePath: string) => boolean;
  exists: (filePath: string) => boolean;
  readDirectory: (dir: string) => Promise<boolean>;
  walkVideos: (root: string) => AsyncIterable<string>;
  stat: (filePath: string) => Promise<IndexedStat>;
  hash: (filePath: string) => Promise<{ hash: string; kind: string }>;
  /** True when the partial hash already covers every byte, so it can confirm a duplicate. */
  hashCoversFile: (size: number) => boolean;
  fullHash: (filePath: string) => Promise<string>;
  probe: (filePath: string) => Promise<ProbeFields>;
  writeThumbnail: (
    filePath: string,
    destPath: string,
    durationMs: number | null,
  ) => Promise<boolean>;
  thumbnailExists: (fileName: string) => boolean;
  now: () => string;
};

export function emptyScanSummary(): ScanSummary {
  return {
    libraries: 0,
    discovered: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
    linked: 0,
    missing: 0,
    offline: 0,
    errors: 0,
  };
}

export function mergeScanSummary(total: ScanSummary, part: ScanSummary): void {
  total.libraries += part.libraries;
  total.discovered += part.discovered;
  total.added += part.added;
  total.updated += part.updated;
  total.unchanged += part.unchanged;
  total.linked += part.linked;
  total.missing += part.missing;
  total.offline += part.offline;
  total.errors += part.errors;
}

/**
 * Same-volume rename: one location whose previous path is gone.
 * A second hard link keeps its own location when that path still exists.
 */
export function pickIdentityMatch<T extends { path: string }>(
  rows: readonly T[],
  filePath: string,
  pathExists: (candidate: string) => boolean,
): T | null {
  const exact = rows.find((row) => pathsEqual(row.path, filePath));
  if (exact) return exact;
  const gone = rows.filter((row) => !pathExists(row.path));
  if (gone.length === 1) return gone[0] ?? null;
  return null;
}

export async function scanLibrary(
  db: Database.Database,
  libraryId: string,
  deps: ScanDeps,
  options: { thumbsDir: string; onProgress?: (progress: ScanProgress) => void },
): Promise<ScanSummary> {
  const repo = createRepository(db);
  const library = repo.getLibrary(libraryId);
  const summary = emptyScanSummary();
  summary.libraries = 1;
  if (!library) {
    summary.errors = 1;
    emit(options.onProgress, {
      state: 'error',
      libraryId,
      libraryLabel: null,
      discovered: 0,
      completed: 0,
      currentFile: null,
      message: 'That library folder is not in the catalog.',
    });
    return summary;
  }

  const mounts = await deps.listMounts();
  const resolved = resolveLibraryPath(library, mounts, {
    existsDir: (candidate) => deps.isDirectory(candidate),
    describe: (candidate) => deps.describePath(candidate, mounts),
  });
  const now = deps.now();

  if (resolved.availability === 'offline') {
    repo.markOffline(library.id, now);
    summary.offline = 1;
    emit(options.onProgress, {
      state: 'done',
      libraryId: library.id,
      libraryLabel: library.label,
      discovered: 0,
      completed: 0,
      currentFile: null,
      message: `${library.label} is offline. The catalog was left unchanged.`,
    });
    return summary;
  }

  const generation = repo.beginScan(library.id, resolved, now);
  if (!(await deps.readDirectory(resolved.path))) {
    const message = 'The folder could not be read. Catalog entries were left unchanged.';
    repo.markUnreadable(library.id, message, deps.now());
    summary.errors = 1;
    emit(options.onProgress, {
      state: 'error',
      libraryId: library.id,
      libraryLabel: library.label,
      discovered: 0,
      completed: 0,
      currentFile: null,
      message,
    });
    return summary;
  }

  const files: string[] = [];
  for await (const file of deps.walkVideos(resolved.path)) {
    files.push(file);
    if (files.length % 50 === 0) {
      emit(
        options.onProgress,
        running(library, files.length, 0, null, `Reading ${library.label}…`),
      );
      await yieldNow();
    }
  }
  summary.discovered = files.length;

  const seen = new Set<string>();
  for (const [index, file] of files.entries()) {
    const filename = fileNameOf(file);
    emit(
      options.onProgress,
      running(
        library,
        files.length,
        index,
        filename,
        `Indexing ${index + 1} of ${files.length} — ${filename}`,
      ),
    );
    try {
      const outcome = await indexFile(repo, deps, options.thumbsDir, {
        libraryId: library.id,
        generation,
        filePath: file,
        seen,
      });
      if (outcome) summary[outcome] += 1;
    } catch (error) {
      summary.errors += 1;
      const message = clipError(error instanceof Error ? error.message : String(error));
      const existing = repo.findLocationByPath(file);
      if (existing) repo.noteError(existing.videoId, message, deps.now());
    }
    await yieldNow();
  }

  summary.missing = repo.markMissing(library.id, generation, deps.now());
  repo.finishScan(library.id, deps.now());
  emit(options.onProgress, {
    state: 'done',
    libraryId: library.id,
    libraryLabel: library.label,
    discovered: files.length,
    completed: files.length,
    currentFile: null,
    message: finishedMessage(library.label, summary),
  });
  return summary;
}

type IndexOutcome = 'added' | 'updated' | 'unchanged' | 'linked';

async function indexFile(
  repo: CatalogRepository,
  deps: ScanDeps,
  thumbsDir: string,
  input: { libraryId: string; generation: number; filePath: string; seen: Set<string> },
): Promise<IndexOutcome | null> {
  let stat: IndexedStat;
  try {
    stat = await deps.stat(input.filePath);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (code === 'ENOENT') return null;
    throw error;
  }

  const filename = fileNameOf(input.filePath);
  const identity =
    stat.volumeId && stat.fileId ? repo.findLocationsByIdentity(stat.volumeId, stat.fileId) : [];
  let location = pickIdentityMatch(identity, input.filePath, (candidate) => deps.exists(candidate));
  if (!location) location = repo.findLocationByPath(input.filePath);
  if (location && input.seen.has(location.id)) location = null;

  const currentVideo = location ? repo.getVideo(location.videoId) : null;
  if (location && currentVideo && canSkipProbe(location, currentVideo, stat, deps)) {
    repo.updateLocation(locationWrite(location.id, location.videoId, input, stat, filename, deps));
    input.seen.add(location.id);
    return changedLocation(location, input.filePath, input.libraryId) ? 'updated' : 'unchanged';
  }

  let contentHash: string | null = null;
  let contentHashKind: string | null = null;
  let hashError: string | null = null;
  try {
    const hashed = await deps.hash(input.filePath);
    contentHash = hashed.hash;
    contentHashKind = hashed.kind;
  } catch (error) {
    hashError = clipError(error instanceof Error ? error.message : String(error));
  }

  const replaced = Boolean(
    currentVideo &&
    contentHash &&
    currentVideo.contentHash &&
    currentVideo.contentHash !== contentHash,
  );
  let target = replaced ? null : currentVideo;
  if (!target && contentHash) {
    target = await confirmContentMatch(repo, deps, {
      filePath: input.filePath,
      hash: contentHash,
      size: stat.size,
      exceptVideoId: replaced ? currentVideo?.id : undefined,
    });
  }

  const probed = await probeFile(input.filePath, deps);
  const captured = chooseCaptureDate({
    metadataCreatedAt: probed.metadataCreatedAt,
    filename,
    fileCreatedAt: stat.birthtime,
    fileModifiedAt: stat.mtime,
  });
  const now = deps.now();

  if (target && location && location.videoId !== target.id) {
    repo.updateLocation(locationWrite(location.id, target.id, input, stat, filename, deps));
    input.seen.add(location.id);
    return 'linked';
  }

  if (target && !location) {
    const moved = claimGoneLocation(repo, deps, target.id, input.seen);
    if (moved) {
      repo.updateLocation(locationWrite(moved.id, target.id, input, stat, filename, deps));
      input.seen.add(moved.id);
      return 'updated';
    }
    const locationId = randomUUID();
    repo.insertLocation(locationWrite(locationId, target.id, input, stat, filename, deps));
    input.seen.add(locationId);
    return 'linked';
  }

  const videoId = target?.id ?? randomUUID();
  const thumbnailFile = await writeVideoThumbnail(
    deps,
    thumbsDir,
    videoId,
    input.filePath,
    probed.durationMs,
    target?.thumbnailFile ?? null,
  );
  const videoWrite = {
    id: videoId,
    contentHash,
    contentHashKind,
    fullHash: target?.fullHash ?? null,
    fullHashKind: target?.fullHash ? FULL_HASH_KIND : null,
    sizeBytes: stat.size,
    durationMs: probed.durationMs,
    width: probed.width,
    height: probed.height,
    videoCodec: probed.videoCodec,
    container: extensionOf(filename),
    capturedAt: captured.capturedAt,
    capturedAtSource: captured.source,
    metadataCreatedAt: probed.metadataCreatedAt,
    metadataError: hashError ?? probed.error,
    thumbnailFile,
    now,
  };
  if (target) repo.updateVideoTechnical(videoWrite);
  else repo.insertVideo(videoWrite);

  if (location) {
    repo.updateLocation(locationWrite(location.id, videoId, input, stat, filename, deps));
    input.seen.add(location.id);
    return replaced ? 'added' : 'updated';
  }
  const locationId = randomUUID();
  repo.insertLocation(locationWrite(locationId, videoId, input, stat, filename, deps));
  input.seen.add(locationId);
  return 'added';
}

async function confirmContentMatch(
  repo: CatalogRepository,
  deps: ScanDeps,
  input: { filePath: string; hash: string; size: number; exceptVideoId?: string },
): Promise<VideoRecord | null> {
  const candidates = repo
    .findVideosByPartialHash(input.hash, input.size)
    .filter((video) => video.id !== input.exceptVideoId);
  if (candidates.length === 0) return null;

  let confirmed: VideoRecord[];
  if (deps.hashCoversFile(input.size)) {
    confirmed = candidates;
  } else {
    const full = await deps.fullHash(input.filePath);
    confirmed = [];
    for (const candidate of candidates) {
      const known = await knownFullHash(repo, deps, candidate);
      if (known && known === full) confirmed.push(repo.getVideo(candidate.id) ?? candidate);
    }
    if (confirmed.length === 0) return null;
    const canonical = collapseMatches(repo, confirmed, deps.now());
    repo.setFullHash(canonical.id, full, FULL_HASH_KIND, deps.now());
    return repo.getVideo(canonical.id);
  }

  return collapseMatches(repo, confirmed, deps.now());
}

async function knownFullHash(
  repo: CatalogRepository,
  deps: ScanDeps,
  video: VideoRecord,
): Promise<string | null> {
  if (video.fullHash) return video.fullHash;
  const sample = repo.locationsForVideo(video.id).find((location) => deps.exists(location.path));
  if (!sample) return null;
  const hash = await deps.fullHash(sample.path);
  repo.setFullHash(video.id, hash, FULL_HASH_KIND, deps.now());
  return hash;
}

function collapseMatches(
  repo: CatalogRepository,
  matches: readonly VideoRecord[],
  now: string,
): VideoRecord {
  const ordered = [...matches].sort((left, right) =>
    left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0,
  );
  const keep = ordered[0];
  if (!keep) throw new Error('Duplicate match list was empty');
  const drops = ordered.slice(1).map((video) => video.id);
  if (drops.length > 0) repo.mergeVideos(keep.id, drops, now);
  return repo.getVideo(keep.id) ?? keep;
}

function claimGoneLocation(
  repo: CatalogRepository,
  deps: ScanDeps,
  videoId: string,
  seen: ReadonlySet<string>,
): LocationRecord | null {
  const gone = repo
    .locationsForVideo(videoId)
    .filter((location) => !seen.has(location.id) && !deps.exists(location.path));
  return gone.length === 1 ? (gone[0] ?? null) : null;
}

async function probeFile(filePath: string, deps: ScanDeps): Promise<ProbeFields> {
  try {
    return await deps.probe(filePath);
  } catch (error) {
    return {
      durationMs: null,
      width: null,
      height: null,
      videoCodec: null,
      metadataCreatedAt: null,
      error: clipError(error instanceof Error ? error.message : String(error)),
    };
  }
}

async function writeVideoThumbnail(
  deps: ScanDeps,
  thumbsDir: string,
  videoId: string,
  filePath: string,
  durationMs: number | null,
  existing: string | null,
): Promise<string | null> {
  const thumbName = thumbnailFileName(videoId);
  try {
    const wrote = await deps.writeThumbnail(filePath, path.join(thumbsDir, thumbName), durationMs);
    if (wrote) return thumbName;
  } catch {
    // The video stays in the catalog. The next scan tries the thumbnail again.
  }
  return existing;
}

function locationWrite(
  id: string,
  videoId: string,
  input: { libraryId: string; generation: number; filePath: string },
  stat: IndexedStat,
  filename: string,
  deps: ScanDeps,
) {
  return {
    id,
    videoId,
    libraryId: input.libraryId,
    path: input.filePath,
    filename,
    volumeId: stat.volumeId,
    fileId: stat.fileId,
    sizeBytes: stat.size,
    mtimeNs: stat.mtimeNs,
    fileCreatedAt: isoOrNull(stat.birthtime),
    fileModifiedAt: isoOrNull(stat.mtime),
    generation: input.generation,
    now: deps.now(),
  };
}

function canSkipProbe(
  location: LocationRecord,
  video: VideoRecord,
  stat: IndexedStat,
  deps: ScanDeps,
): boolean {
  if (location.sizeBytes !== stat.size || location.mtimeNs !== stat.mtimeNs) return false;
  if (!video.contentHash || video.metadataError) return false;
  if (video.durationMs == null && video.videoCodec == null) return false;
  if (!video.thumbnailFile || !deps.thumbnailExists(video.thumbnailFile)) return false;
  return true;
}

function changedLocation(location: LocationRecord, filePath: string, libraryId: string): boolean {
  return (
    !pathsEqual(location.path, filePath) ||
    location.libraryId !== libraryId ||
    location.presence !== 'present'
  );
}

function fileNameOf(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/');
  const index = normalized.lastIndexOf('/');
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function extensionOf(filename: string): string | null {
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  if (!extension || extension === filename.toLowerCase()) return null;
  return extension;
}

function isoOrNull(date: Date | null): string | null {
  if (!date || !Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

function running(
  library: { id: string; label: string },
  discovered: number,
  completed: number,
  currentFile: string | null,
  message: string,
): ScanProgress {
  return {
    state: 'running',
    libraryId: library.id,
    libraryLabel: library.label,
    discovered,
    completed,
    currentFile,
    message,
  };
}

function finishedMessage(label: string, summary: ScanSummary): string {
  return `${label}: ${summary.added} new, ${summary.linked} copies, ${summary.updated} updated, ${summary.unchanged} unchanged, ${summary.missing} missing.`;
}

function emit(
  onProgress: ((progress: ScanProgress) => void) | undefined,
  progress: ScanProgress,
): void {
  onProgress?.(progress);
}

function yieldNow(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
