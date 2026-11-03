import path from 'node:path';

/** Windows paths compare case-insensitively. Other platforms do not. */
export function pathsEqual(left: string, right: string): boolean {
  if (process.platform === 'win32') {
    return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
  }
  return path.normalize(left) === path.normalize(right);
}
