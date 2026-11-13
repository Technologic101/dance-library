import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type {
  AddLibrariesResult,
  LibrarySummary,
  ScanProgress,
  ScanSummary,
  VideoChangeResult,
  VideoCounts,
  VideoListPage,
  VideoQuery,
  CatalogFacets,
  BulkVideoUpdate,
  CatalogValueKind,
  VideoUpdate,
} from '../shared/api';
import { createCatalogEditor } from './catalogEditing';
import { createScanDeps } from './indexer/fsDeps';
import { createRepository, type CatalogRepository } from './indexer/repository';
import { emptyScanSummary, mergeScanSummary, scanLibrary, type ScanDeps } from './indexer/scan';

type ScanListener = (progress: ScanProgress) => void;

export function libraryLabel(folder: string): string {
  const base = path.basename(folder);
  return base || folder;
}

export function createLibraryService(
  db: Database.Database,
  thumbsDir: string,
  deps: ScanDeps = createScanDeps(thumbsDir),
) {
  const repo = createRepository(db);
  const editor = createCatalogEditor(db);
  let gate: Promise<void> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = gate.then(task, task);
    gate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    listLibraries(): LibrarySummary[] {
      return repo.listLibrarySummaries();
    },

    listVideos(options?: VideoQuery): VideoListPage {
      const query = { ...options };
      if (query.limit == null) query.limit = 48;
      if (query.offset == null) query.offset = 0;
      return {
        items: repo.listVideoSummaries(query),
        total: repo.countVideoSummaries(query),
      };
    },

    listFacets(options?: { excluded?: boolean }): CatalogFacets {
      return repo.listFacets(options?.excluded ?? false);
    },

    countVideos(): VideoCounts {
      return repo.countVideos();
    },

    getVideoDetails(id: string) {
      return editor.getVideoDetails(repo.resolveVideoId(id));
    },
    updateVideo(id: string, patch: VideoUpdate) {
      return Promise.resolve(editor.updateVideo(repo.resolveVideoId(id), patch));
    },
    bulkUpdateVideos(ids: readonly string[], patch: BulkVideoUpdate): Promise<VideoChangeResult> {
      const resolved = [...new Set(ids.map((id) => repo.resolveVideoId(id)))];
      return Promise.resolve({
        ...editor.bulkUpdate(resolved, patch),
        requested: resolved.length,
      });
    },
    undoLastEdit(token?: string) {
      return Promise.resolve(editor.undoLastEdit((id) => repo.resolveVideoId(id), token));
    },
    searchCatalogValues(kind: CatalogValueKind, query: string) {
      return editor.searchValues(kind, query);
    },
    createCatalogValue(kind: CatalogValueKind, name: string) {
      return editor.createValue(kind, name);
    },
    linkLessonDemo(lessonId: string, demoId: string) {
      editor.linkLessonDemo(repo.resolveVideoId(lessonId), repo.resolveVideoId(demoId));
      return Promise.resolve();
    },
    unlinkLessonDemo(lessonId: string, demoId: string) {
      editor.unlinkLessonDemo(repo.resolveVideoId(lessonId), repo.resolveVideoId(demoId));
      return Promise.resolve();
    },

    excludeVideos(ids: readonly string[]): Promise<VideoChangeResult> {
      return Promise.resolve({
        changed: repo.excludeVideos(ids, new Date().toISOString()),
        requested: ids.length,
      });
    },

    restoreVideos(ids: readonly string[]): Promise<VideoChangeResult> {
      return Promise.resolve({
        changed: repo.restoreVideos(ids, new Date().toISOString()),
        requested: ids.length,
      });
    },

    addPaths(
      folderPaths: readonly string[],
      onProgress?: ScanListener,
    ): Promise<AddLibrariesResult> {
      return enqueue(async () => {
        const addedIds: string[] = [];
        const skipped: AddLibrariesResult['skipped'] = [];
        for (const folder of folderPaths) {
          const resolved = path.resolve(folder);
          const rejection = rejectionMessage(repo, resolved);
          if (rejection) {
            skipped.push({ path: resolved, message: rejection });
            continue;
          }
          const library = repo.insertLibrary({
            id: randomUUID(),
            path: resolved,
            label: libraryLabel(resolved),
            now: new Date().toISOString(),
          });
          addedIds.push(library.id);
        }

        let scan: ScanSummary | null = null;
        if (addedIds.length > 0) {
          scan = emptyScanSummary();
          for (const id of addedIds) {
            mergeScanSummary(scan, await scanLibrary(db, id, deps, { thumbsDir, onProgress }));
          }
        }
        const added = repo
          .listLibrarySummaries()
          .filter((library) => addedIds.includes(library.id));
        return { added, skipped, scan };
      });
    },

    removeLibrary(id: string): Promise<boolean> {
      return enqueue(async () => {
        const removed = repo.removeLibrary(id);
        if (!removed) return false;
        const protectedIds = new Set(
          [...editor.protectedUndoIds()].map((videoId) => repo.resolveVideoId(videoId)),
        );
        for (const name of repo.deleteEmptyOrphans(protectedIds)) {
          const base = path.basename(name);
          if (base !== name) continue;
          fs.rmSync(path.join(thumbsDir, base), { force: true });
        }
        return true;
      });
    },

    scanLibrary(id: string, onProgress?: ScanListener): Promise<ScanSummary> {
      return enqueue(() => scanLibrary(db, id, deps, { thumbsDir, onProgress }));
    },

    scanAll(onProgress?: ScanListener): Promise<ScanSummary> {
      return enqueue(async () => {
        const summary = emptyScanSummary();
        const libraries = repo.listLibraries();
        if (libraries.length === 0) {
          onProgress?.({
            state: 'done',
            libraryId: null,
            libraryLabel: null,
            discovered: 0,
            completed: 0,
            currentFile: null,
            message: 'No folders to scan.',
          });
          return summary;
        }
        for (const library of libraries) {
          mergeScanSummary(
            summary,
            await scanLibrary(db, library.id, deps, { thumbsDir, onProgress }),
          );
        }
        return summary;
      });
    },
  };
}

export type LibraryService = ReturnType<typeof createLibraryService>;

function rejectionMessage(repo: CatalogRepository, candidate: string): string | null {
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
    return 'That folder does not exist.';
  }
  const candidateKey = canonical(candidate);
  for (const library of repo.listLibraries()) {
    const existingKey = canonical(library.path);
    if (candidateKey === existingKey) return 'That folder is already in the library.';
    const inward = path.relative(existingKey, candidateKey);
    const outward = path.relative(candidateKey, existingKey);
    if (isInside(inward)) return 'That folder is inside a folder already in the library.';
    if (isInside(outward)) {
      return 'A folder inside that one is already in the library. Remove it first.';
    }
  }
  return null;
}

function canonical(folder: string): string {
  const resolved = path.resolve(folder);
  try {
    const real = fs.realpathSync(resolved);
    return process.platform === 'win32' ? real.toLowerCase() : real;
  } catch {
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
}

function isInside(relative: string): boolean {
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
