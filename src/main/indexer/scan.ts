import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { CaptureDateSource, ScanProgress, ScanSummary } from '../../shared/api';
import { chooseCaptureDate, captureDateFromFilename } from './captureDate';
import { pathsEqual } from './paths';
import { clipError } from './process';
import { createRepository, type CatalogRepository, type VideoIdentity } from './repository';
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
  total.missing += part.missing;
  total.offline += part.offline;
  total.errors += part.errors;
}

/**
 * Same-volume rename: one catalog row whose previous path is gone.
 * A second hard link keeps its own row when that path still exists.
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
      const existing = repo.findByPath(file);
      if (existing) repo.noteError(existing.id, message, generation, deps.now());
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

type IndexOutcome = 'added' | 'updated' | 'unchanged';

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
    stat.volumeId && stat.fileId ? repo.findByIdentity(stat.volumeId, stat.fileId) : [];
  let row = pickIdentityMatch(identity, input.filePath, (candidate) => deps.exists(candidate));
  if (!row) row = repo.findByPath(input.filePath);
  if (row && input.seen.has(row.id)) row = null;

  if (row && canSkipProbe(row, stat, deps)) {
    const captured = fastCaptureDate(row, filename);
    repo.touchVideo({
      id: row.id,
      libraryId: input.libraryId,
      path: input.filePath,
      filename,
      volumeId: stat.volumeId,
      fileId: stat.fileId,
      capturedAt: captured.capturedAt,
      capturedAtSource: captured.source,
      generation: input.generation,
      now: deps.now(),
    });
    input.seen.add(row.id);
    return changedLocation(row, input.filePath, input.libraryId) ? 'updated' : 'unchanged';
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

  if (!row && contentHash) {
    const candidates = repo.findByHash(contentHash, stat.size).filter((candidate) => {
      if (input.seen.has(candidate.id)) return false;
      if (pathsEqual(candidate.path, input.filePath)) return false;
      return !deps.exists(candidate.path);
    });
    if (candidates.length === 1) row = candidates[0] ?? null;
  }

  let probe: ProbeFields;
  try {
    probe = await deps.probe(input.filePath);
  } catch (error) {
    probe = {
      durationMs: null,
      width: null,
      height: null,
      videoCodec: null,
      metadataCreatedAt: null,
      error: clipError(error instanceof Error ? error.message : String(error)),
    };
  }
  const captured = chooseCaptureDate({
    metadataCreatedAt: probe.metadataCreatedAt,
    filename,
    fileCreatedAt: stat.birthtime,
    fileModifiedAt: stat.mtime,
  });
  const id = row?.id ?? randomUUID();
  const thumbName = thumbnailFileName(id);
  let thumbnailFile = row?.thumbnailFile ?? null;
  try {
    const wrote = await deps.writeThumbnail(
      input.filePath,
      path.join(thumbsDir, thumbName),
      probe.durationMs,
    );
    if (wrote) thumbnailFile = thumbName;
  } catch {
    // The video stays in the catalog. The next scan tries the thumbnail again.
  }

  const technical = {
    id,
    libraryId: input.libraryId,
    path: input.filePath,
    filename,
    volumeId: stat.volumeId,
    fileId: stat.fileId,
    contentHash,
    contentHashKind,
    sizeBytes: stat.size,
    mtimeNs: stat.mtimeNs,
    durationMs: probe.durationMs,
    width: probe.width,
    height: probe.height,
    videoCodec: probe.videoCodec,
    container: extensionOf(filename),
    capturedAt: captured.capturedAt,
    capturedAtSource: captured.source,
    metadataCreatedAt: probe.metadataCreatedAt,
    fileCreatedAt: isoOrNull(stat.birthtime),
    fileModifiedAt: isoOrNull(stat.mtime),
    metadataError: hashError ?? probe.error,
    thumbnailFile,
    generation: input.generation,
    now: deps.now(),
  };
  if (row) repo.updateTechnical(technical);
  else repo.insertVideo(technical);
  input.seen.add(id);
  return row ? 'updated' : 'added';
}

function canSkipProbe(video: VideoIdentity, stat: IndexedStat, deps: ScanDeps): boolean {
  if (video.sizeBytes !== stat.size || video.mtimeNs !== stat.mtimeNs) return false;
  if (!video.contentHash || video.metadataError) return false;
  if (video.durationMs == null && video.videoCodec == null) return false;
  if (!video.thumbnailFile || !deps.thumbnailExists(video.thumbnailFile)) return false;
  return true;
}

function fastCaptureDate(
  video: VideoIdentity,
  filename: string,
): { capturedAt: string | null; source: CaptureDateSource | null } {
  if (video.capturedAtSource === 'metadata' || video.capturedAtSource === 'file_time') {
    return { capturedAt: video.capturedAt, source: video.capturedAtSource };
  }
  const fromName = captureDateFromFilename(filename);
  if (fromName) return { capturedAt: fromName, source: 'filename' };
  return { capturedAt: video.capturedAt, source: video.capturedAtSource };
}

function changedLocation(video: VideoIdentity, filePath: string, libraryId: string): boolean {
  return (
    !pathsEqual(video.path, filePath) ||
    video.libraryId !== libraryId ||
    video.presence !== 'present'
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
  return `${label}: ${summary.added} new, ${summary.updated} updated, ${summary.unchanged} unchanged, ${summary.missing} missing.`;
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
