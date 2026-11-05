import path from 'node:path';

/**
 * Lookup key for a path. Separators are normalized. On Windows the key is
 * Unicode-case-folded so a case-only rename does not create a second row.
 */
export function pathKey(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/').replace(/\/+$/, '');
  if (process.platform === 'win32') return normalized.toLowerCase();
  return normalized;
}

export function parentDir(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (slash <= 0) return filePath;
  return filePath.slice(0, slash);
}

/** Windows paths compare case-insensitively. Other platforms do not. */
export function pathsEqual(left: string, right: string): boolean {
  if (process.platform === 'win32') {
    return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
  }
  return path.normalize(left) === path.normalize(right);
}
