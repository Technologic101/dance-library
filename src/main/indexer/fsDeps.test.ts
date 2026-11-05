import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createScanDeps } from './fsDeps';

const directories: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dance-library-entries-'));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('directoryHasEntries', () => {
  it('ignores system junk, sees a real file, and reports an unreadable path', async () => {
    const thumbs = tempDir();
    const deps = createScanDeps(thumbs);
    const folder = tempDir();
    expect(await deps.directoryHasEntries(folder)).toBe(false);
    fs.writeFileSync(path.join(folder, '.DS_Store'), 'x');
    fs.mkdirSync(path.join(folder, '.Spotlight-V100'));
    fs.writeFileSync(path.join(folder, 'System Volume Information'), 'x');
    expect(await deps.directoryHasEntries(folder)).toBe(false);
    fs.writeFileSync(path.join(folder, 'clip.mp4'), 'x');
    expect(await deps.directoryHasEntries(folder)).toBe(true);
    expect(await deps.directoryHasEntries(path.join(folder, 'missing'))).toBeNull();
  });
});
