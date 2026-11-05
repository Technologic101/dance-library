import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
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
import { isStableVolumeId, resolveLibraryPath, type Mount, type VolumeLocation } from './volumes';
import { parentDir } from './paths';

export type IndexedStat = {
  size: number;
  mtimeNs: string;
  mtime: Date;
  birthtime: Date | null;
  fileId: string | null;
  volumeId: string | null;
  /** False on FAT, exFAT, and network filesystems, where inode numbers are reused. */
  fileIdStable?: boolean;
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
  /**
   * True when the directory has a real entry, false when it is empty or only
   * has system junk, null when it could not be read.
   */
  directoryHasEntries: (dir: string) => Promise<boolean | null>;
  walkVideos: (root: string) => AsyncIterable<string>;
  /** When set, unreadable directories are not treated as missing files. */
  walkLibrary?: (root: string) => Promise<{
    files: string[];
    listed: string[];
    unreadable: string[];
  }>;
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
  let resolved = resolveLibraryPath(library, mounts, {
    existsDir: (candidate) => deps.isDirectory(candidate),
    describe: (candidate) => deps.describePath(candidate, mounts),
  });
  const savedVolume = {
    path: library.path,
    volumeId: isStableVolumeId(library.volumeId) ? library.volumeId : null,
    volumeRelPath: library.volumeRelPath,
  };
  if (mounts.length === 0 && deps.isDirectory(library.path)) {
    const rootState = await deps.directoryHasEntries(library.path);
    if (rootState === null) {
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
    if (!rootState) {
      if (repo.countLocations(library.id) > 0) {
        resolved = { availability: 'offline', ...savedVolume };
      }
    } else {
      const verdict = await rootVolumeVerdict(library.volumeId, library.path, deps);
      const proven =
        verdict === 'match' ||
        (verdict === 'unknown' && (await filesStillThere(repo, deps, library.id)));
      if (!proven) resolved = { availability: 'offline', ...savedVolume };
    }
  } else if (resolved.availability === 'offline' && deps.isDirectory(library.path)) {
    if (await filesStillThere(repo, deps, library.id)) {
      resolved = { availability: 'online', ...savedVolume };
    }
  }
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

  const walked = await collectWalk(deps, resolved.path, (count) => {
    emit(options.onProgress, running(library, count, 0, null, `Reading ${library.label}…`));
  });
  const files = walked.files;
  summary.discovered = files.length;

  const seen = new Set<string>();
  const presentAtStart = repo
    .locationsForLibrary(library.id)
    .filter((location) => location.presence === 'present')
    .map((location) => location.id);
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
      if (existing) {
        repo.noteError(existing.videoId, message, deps.now());
        seen.add(existing.id);
      }
    }
    await yieldNow();
  }

  const refuseMissing =
    mounts.length === 0 &&
    mostPresentWouldBeMissing(presentAtStart, seen, walked.unreadable, repo, library.id);
  if (!refuseMissing) {
    summary.missing = markUnseen(
      repo,
      deps,
      options.thumbsDir,
      library.id,
      resolved.path,
      walked,
      seen,
    );
  } else {
    summary.errors += 1;
  }
  repo.finishScan(library.id, deps.now());
  if (refuseMissing) {
    repo.markUnreadable(
      library.id,
      'The drive listing was empty, so files were not marked missing.',
      deps.now(),
    );
  }
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
  let location = repo.findLocationByPath(input.filePath);
  if (location && input.seen.has(location.id)) location = null;
  if (!location && stat.fileId && stat.volumeId && stat.fileIdStable !== false) {
    location = await identityLocation(
      repo,
      deps,
      stat,
      input.filePath,
      input.seen,
      null,
      input.libraryId,
    );
  }

  if (stat.size === 0) {
    if (location) {
      repo.updateLocation(
        locationWrite(
          location.id,
          location.videoId,
          input,
          stat,
          filename,
          deps,
          location.volumeId,
        ),
      );
      input.seen.add(location.id);
    }
    return null;
  }

  const currentVideo = location ? repo.getVideo(location.videoId) : null;
  if (location && currentVideo && canSkipProbe(location, currentVideo, stat, deps)) {
    repo.updateLocation(
      locationWrite(location.id, location.videoId, input, stat, filename, deps, location.volumeId),
    );
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

  if (!location && contentHash && stat.fileId && stat.volumeId && stat.fileIdStable !== false) {
    location = await identityLocation(
      repo,
      deps,
      stat,
      input.filePath,
      input.seen,
      contentHash,
      input.libraryId,
    );
  }

  const boundVideo = location ? repo.getVideo(location.videoId) : currentVideo;
  const hashChanged = Boolean(
    contentHash && boundVideo?.contentHash && boundVideo.contentHash !== contentHash,
  );
  const hashMissing = Boolean(contentHash && boundVideo && !boundVideo.contentHash);
  const fullHashMissing = Boolean(
    contentHash && !deps.hashCoversFile(stat.size) && !boundVideo?.fullHash,
  );
  const plan =
    contentHash && (!boundVideo?.contentHash || hashChanged || fullHashMissing)
      ? await planContentMatch(repo, deps, {
          filePath: input.filePath,
          hash: contentHash,
          size: stat.size,
          exceptVideoId: hashChanged ? boundVideo?.id : undefined,
        })
      : {
          keepId: null,
          mergeIds: [] as string[],
          fullHash: null as string | null,
          fullHashError: null as string | null,
        };

  let target = hashChanged ? null : boundVideo;
  const mergeIds = [...new Set(plan.mergeIds)];
  if (plan.keepId && (!target || target.id !== plan.keepId)) {
    if (target && target.id !== plan.keepId) mergeIds.push(target.id);
    target = repo.getVideo(plan.keepId);
  } else if (!plan.keepId && hashChanged) {
    target = null;
  }
  if (hashMissing && plan.keepId && boundVideo && boundVideo.id !== plan.keepId) {
    if (!mergeIds.includes(boundVideo.id)) mergeIds.push(boundVideo.id);
  }

  const probed = await probeFile(input.filePath, deps);
  const captured = chooseCaptureDate({
    metadataCreatedAt: probed.metadataCreatedAt,
    filename,
    fileCreatedAt: stat.birthtime,
    fileModifiedAt: stat.mtime,
  });
  const now = deps.now();
  const thumbId = target?.id ?? randomUUID();
  const thumbnailFile = await writeVideoThumbnail(
    deps,
    thumbsDir,
    thumbId,
    input.filePath,
    probed.durationMs,
    target?.thumbnailFile ?? null,
  );

  let outcome: IndexOutcome = 'added';
  repo.transaction(() => {
    let videoId = target?.id ?? thumbId;
    if (plan.fullHash) {
      const owner = repo.findVideoByFullHash(plan.fullHash);
      if (owner && owner.id !== videoId) {
        if (repo.getVideo(videoId)) repo.mergeVideos(owner.id, [videoId, ...mergeIds], now);
        else if (mergeIds.length > 0) repo.mergeVideos(owner.id, mergeIds, now);
        videoId = owner.id;
      } else if (mergeIds.length > 0 && repo.getVideo(videoId)) {
        repo.mergeVideos(videoId, mergeIds, now);
      }
    } else if (mergeIds.length > 0 && repo.getVideo(videoId)) {
      repo.mergeVideos(videoId, mergeIds, now);
    }
    const videoWrite = {
      id: videoId,
      contentHash,
      contentHashKind,
      fullHash: plan.fullHash,
      fullHashKind: plan.fullHash ? FULL_HASH_KIND : null,
      sizeBytes: stat.size,
      durationMs: probed.durationMs,
      width: probed.width,
      height: probed.height,
      videoCodec: probed.videoCodec,
      container: extensionOf(filename),
      capturedAt: captured.capturedAt,
      capturedAtSource: captured.source,
      metadataCreatedAt: probed.metadataCreatedAt,
      metadataError: hashError ?? plan.fullHashError ?? probed.error,
      thumbnailFile,
      now,
    };
    const existed = repo.getVideo(videoId);
    if (existed) repo.updateVideoTechnical(videoWrite);
    else repo.insertVideo(videoWrite);

    const moved = !location
      ? claimGoneLocation(repo, deps, videoId, input.seen, input.libraryId)
      : null;
    const kept = location ?? moved;
    const locationId = kept?.id ?? randomUUID();
    const write = locationWrite(locationId, videoId, input, stat, filename, deps, kept?.volumeId);
    if (location || moved) repo.updateLocation(write);
    else repo.insertLocation(write);
    input.seen.add(locationId);

    if (!existed && !location && !moved) outcome = 'added';
    else if (!location && !moved) outcome = 'linked';
    else if (location && location.videoId !== videoId) outcome = 'linked';
    else if (hashChanged && !plan.keepId) outcome = 'added';
    else {
      const previous = location ?? moved;
      outcome =
        previous && changedLocation(previous, input.filePath, input.libraryId)
          ? 'updated'
          : 'unchanged';
    }
  });
  return outcome;
}

type MatchPlan = {
  keepId: string | null;
  mergeIds: string[];
  fullHash: string | null;
  fullHashError: string | null;
};

async function planContentMatch(
  repo: CatalogRepository,
  deps: ScanDeps,
  input: { filePath: string; hash: string; size: number; exceptVideoId?: string },
): Promise<MatchPlan> {
  const covers = deps.hashCoversFile(input.size);
  let fullHash: string | null = null;
  let fullHashError: string | null = null;
  if (!covers) {
    try {
      fullHash = await deps.fullHash(input.filePath);
    } catch (error) {
      fullHash = null;
      fullHashError = clipError(error instanceof Error ? error.message : String(error));
    }
  }
  const candidates = repo
    .findVideosByPartialHash(input.hash, input.size)
    .filter((video) => video.id !== input.exceptVideoId);
  const groups = new Map<string, VideoRecord[]>();
  const add = (hash: string, video: VideoRecord) => {
    const group = groups.get(hash) ?? [];
    if (!group.some((item) => item.id === video.id)) group.push(video);
    groups.set(hash, group);
  };
  if (covers) {
    for (const candidate of candidates) add(input.hash, candidate);
  } else {
    for (const candidate of candidates) {
      const known = await readCandidateFullHash(repo, deps, candidate, {
        filePath: input.filePath,
        fullHash,
      });
      if (known) add(known, candidate);
    }
    if (fullHash) {
      const owner = repo.findVideoByFullHash(fullHash);
      if (owner && owner.id !== input.exceptVideoId) add(fullHash, owner);
    }
  }
  const key = covers ? input.hash : fullHash;
  const matched = key ? (groups.get(key) ?? []) : [];
  if (matched.length === 0) return { keepId: null, mergeIds: [], fullHash, fullHashError };
  const ordered = [...matched].sort((left, right) => (left.createdAt < right.createdAt ? -1 : 1));
  const keep = ordered[0];
  if (!keep) return { keepId: null, mergeIds: [], fullHash, fullHashError };
  return {
    keepId: keep.id,
    mergeIds: ordered.slice(1).map((video) => video.id),
    fullHash,
    fullHashError,
  };
}

async function readCandidateFullHash(
  repo: CatalogRepository,
  deps: ScanDeps,
  video: VideoRecord,
  known?: { filePath: string; fullHash: string | null },
): Promise<string | null> {
  if (video.fullHash) return video.fullHash;
  for (const location of repo.locationsForVideo(video.id)) {
    if (known && pathsEqual(location.path, known.filePath)) {
      if (known.fullHash) return known.fullHash;
      continue;
    }
    if (!deps.exists(location.path)) continue;
    let stat: IndexedStat;
    try {
      stat = await deps.stat(location.path);
    } catch {
      continue;
    }
    if (location.volumeId && stat.volumeId && location.volumeId !== stat.volumeId) continue;
    if (location.sizeBytes != null && stat.size !== location.sizeBytes) continue;
    if (location.mtimeNs && stat.mtimeNs !== location.mtimeNs) continue;
    if (video.contentHash) {
      try {
        const partial = await deps.hash(location.path);
        if (partial.hash !== video.contentHash) continue;
      } catch {
        continue;
      }
    }
    try {
      return await deps.fullHash(location.path);
    } catch {
      continue;
    }
  }
  return null;
}

async function identityLocation(
  repo: CatalogRepository,
  deps: ScanDeps,
  stat: IndexedStat,
  filePath: string,
  seen: ReadonlySet<string>,
  contentHash: string | null,
  libraryId: string,
): Promise<LocationRecord | null> {
  if (!stat.volumeId || !stat.fileId) return null;
  const rows = repo.findLocationsByIdentity(stat.volumeId, stat.fileId);
  const candidate = pickIdentityMatch(rows, filePath, (candidatePath) =>
    deps.exists(candidatePath),
  );
  if (candidate && !seen.has(candidate.id)) {
    const video = repo.getVideo(candidate.videoId);
    const sameTime = candidate.sizeBytes === stat.size && candidate.mtimeNs === stat.mtimeNs;
    const sameHash = Boolean(contentHash && video?.contentHash === contentHash);
    if (sameTime || sameHash) return candidate;
  }
  // A case-only rename on a case-insensitive volume still "exists" at the old
  // spelling. The inode matches, so rewrite that row instead of adding one.
  for (const row of rows) {
    if (seen.has(row.id) || pathsEqual(row.path, filePath)) continue;
    if (row.libraryId !== libraryId || !isCaseAlias(row.path, filePath)) continue;
    try {
      const alias = await deps.stat(row.path);
      if (
        alias.fileId &&
        alias.fileId === stat.fileId &&
        alias.volumeId === stat.volumeId &&
        alias.size === stat.size
      ) {
        return row;
      }
    } catch {
      // The stored path is not a readable alias of this file.
    }
  }
  return null;
}

async function filesStillThere(
  repo: CatalogRepository,
  deps: ScanDeps,
  libraryId: string,
): Promise<boolean> {
  let sample = repo.samplePresentLocations(libraryId, 20);
  if (sample.length === 0) {
    if (repo.countLocations(libraryId) === 0) return true;
    sample = repo.sampleLocations(libraryId, 20);
  }
  let matched = 0;
  for (const location of sample) {
    if (!deps.exists(location.path)) continue;
    try {
      const stat = await deps.stat(location.path);
      if (!sampleConfirms(location, stat)) continue;
      matched += 1;
    } catch {
      // A path that cannot be stated is not evidence this is the same disk.
    }
  }
  return matched > 0;
}

function sampleConfirms(location: LocationRecord, stat: IndexedStat): boolean {
  if (location.sizeBytes != null && stat.size !== location.sizeBytes) return false;
  if (location.fileId && stat.fileId && location.fileId !== stat.fileId) return false;
  return location.sizeBytes != null || Boolean(location.fileId && stat.fileId);
}

/** A null id is unknown. Only two known, different ids are a mismatch. */
async function rootVolumeVerdict(
  savedVolumeId: string | null,
  root: string,
  deps: ScanDeps,
): Promise<'match' | 'mismatch' | 'unknown'> {
  let observed: string | null = null;
  try {
    const stat = await deps.stat(root);
    observed = isStableVolumeId(stat.volumeId) ? stat.volumeId : null;
  } catch {
    return 'unknown';
  }
  const saved = isStableVolumeId(savedVolumeId) ? savedVolumeId : null;
  if (!observed || !saved) return 'unknown';
  return observed === saved ? 'match' : 'mismatch';
}

function mostPresentWouldBeMissing(
  presentAtStart: readonly string[],
  seen: ReadonlySet<string>,
  unreadable: readonly string[],
  repo: CatalogRepository,
  libraryId: string,
): boolean {
  if (presentAtStart.length === 0) return false;
  const byId = new Map(
    repo.locationsForLibrary(libraryId).map((location) => [location.id, location.path]),
  );
  const missing = presentAtStart.filter((id) => {
    const stored = byId.get(id);
    if (!stored || seen.has(id)) return false;
    return !underDirectory(stored, unreadable);
  });
  return missing.length / presentAtStart.length > 0.9;
}

function isCaseAlias(stored: string, current: string): boolean {
  const fold = (value: string) => value.replaceAll('\\', '/').normalize('NFC').toLowerCase();
  return fold(stored) === fold(current);
}

function claimGoneLocation(
  repo: CatalogRepository,
  deps: ScanDeps,
  videoId: string,
  seen: ReadonlySet<string>,
  libraryId: string,
): LocationRecord | null {
  const gone = repo.locationsForVideo(videoId).filter((location) => {
    return (
      !seen.has(location.id) && location.libraryId === libraryId && !deps.exists(location.path)
    );
  });
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
  keptVolumeId?: string | null,
) {
  return {
    id,
    videoId,
    libraryId: input.libraryId,
    path: input.filePath,
    filename,
    volumeId: stat.volumeId ?? keptVolumeId ?? null,
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
  if (!video.fullHash && !deps.hashCoversFile(location.sizeBytes ?? stat.size)) return false;
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

async function collectWalk(
  deps: ScanDeps,
  root: string,
  onBatch: (count: number) => void,
): Promise<{ files: string[]; listed: Set<string>; unreadable: string[] }> {
  if (deps.walkLibrary) {
    const walked = await deps.walkLibrary(root);
    return { files: walked.files, listed: new Set(walked.listed), unreadable: walked.unreadable };
  }
  const files: string[] = [];
  const listed = new Set<string>([root]);
  for await (const file of deps.walkVideos(root)) {
    files.push(file);
    listed.add(parentDir(file));
    if (files.length % 50 === 0) {
      onBatch(files.length);
      await yieldNow();
    }
  }
  return { files, listed, unreadable: [] };
}

function markUnseen(
  repo: CatalogRepository,
  deps: ScanDeps,
  thumbsDir: string,
  libraryId: string,
  root: string,
  walked: { listed: Set<string>; unreadable: string[] },
  seen: ReadonlySet<string>,
): number {
  if (!deps.isDirectory(root)) return 0;
  const ids = repo
    .locationsForLibrary(libraryId)
    .filter((location) => {
      if (seen.has(location.id)) return false;
      return !underDirectory(location.path, walked.unreadable);
    })
    .map((location) => location.id);
  const missing = repo.markMissingIds(ids, deps.now());
  for (const name of repo.deleteEmptyOrphans()) {
    const base = path.basename(name);
    if (base === name) fs.rmSync(path.join(thumbsDir, base), { force: true });
  }
  return missing;
}

function underDirectory(filePath: string, directories: readonly string[]): boolean {
  return directories.some((dir) => {
    if (filePath === dir) return true;
    const separator = filePath.includes('\\') ? '\\' : '/';
    const prefix = dir.endsWith('/') || dir.endsWith('\\') ? dir : `${dir}${separator}`;
    return filePath.startsWith(prefix);
  });
}

function yieldNow(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
