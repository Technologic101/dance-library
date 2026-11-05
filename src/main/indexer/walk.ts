import fs from 'node:fs';
import path from 'node:path';

/** Extensions compared without the dot, in lowercase. */
export const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  '3g2',
  '3gp',
  'asf',
  'avi',
  'divx',
  'flv',
  'h264',
  'h265',
  'hevc',
  'm2ts',
  'm2v',
  'm4v',
  'mkv',
  'mov',
  'mp4',
  'mpeg',
  'mpg',
  'mts',
  'mxf',
  'ogv',
  'qt',
  'ts',
  'vob',
  'webm',
  'wmv',
]);

const SKIP_DIRECTORIES = new Set([
  '#recycle',
  '$RECYCLE.BIN',
  '.Spotlight-V100',
  '.Trash',
  '.Trash-1000',
  '.Trashes',
  '.fseventsd',
  '@eaDir',
  'System Volume Information',
]);

/**
 * Video files under root. Hidden directories, system folders, and symlinks
 * are skipped so a scan cannot loop or leave the folder the user added.
 */
export type WalkLibraryResult = {
  files: string[];
  listed: string[];
  unreadable: string[];
};

/** Lists videos and records which directories could not be read. */
export async function walkLibrary(root: string): Promise<WalkLibraryResult> {
  const files: string[] = [];
  const listed: string[] = [];
  const unreadable: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      unreadable.push(dir);
      continue;
    }
    listed.push(dir);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).slice(1).toLowerCase();
      if (VIDEO_EXTENSIONS.has(extension)) files.push(full);
    }
  }
  return { files, listed, unreadable };
}

export async function* walkVideos(root: string): AsyncGenerator<string> {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).slice(1).toLowerCase();
      if (VIDEO_EXTENSIONS.has(extension)) yield full;
    }
  }
}

export async function directoryReadable(dir: string): Promise<boolean> {
  try {
    await fs.promises.readdir(dir);
    return true;
  } catch {
    return false;
  }
}
