import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createScanDeps, statIndexedFile } from './fsDeps';
import { windowsVolumeIdFromSerial } from './volumes';

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
    fs.writeFileSync(path.join(folder, 'desktop.ini'), 'x');
    expect(await deps.directoryHasEntries(folder)).toBe(false);
    fs.writeFileSync(path.join(folder, 'clip.mp4'), 'x');
    expect(await deps.directoryHasEntries(folder)).toBe(true);
    expect(await deps.directoryHasEntries(path.join(folder, 'missing'))).toBeNull();
  });

  it('leaves the volume unknown when the mount listing is empty, except for a windows serial', async () => {
    const file = path.join(tempDir(), 'clip.mp4');
    fs.writeFileSync(file, 'x');
    const stat = await statIndexedFile(file, []);
    if (process.platform === 'win32') {
      const raw = await fs.promises.stat(file, { bigint: true });
      expect(stat.volumeId).toBe(raw.dev > 0n ? windowsVolumeIdFromSerial(raw.dev) : null);
    } else {
      expect(stat.volumeId).toBeNull();
    }
  });
});

describe('sameFilePathAlias', () => {
  it('uses real filesystem canonical paths and does not confuse hard links or symlinks', async () => {
    const root = tempDir();
    const thumbs = tempDir();
    const deps = createScanDeps(thumbs);
    const original = path.join(root, 'Clip.mp4');
    const otherCase = path.join(root, 'clip.mp4');
    fs.writeFileSync(original, 'video');

    if (fs.existsSync(otherCase)) {
      expect(await deps.sameFilePathAlias?.(original, otherCase)).toBe(true);
    } else {
      fs.linkSync(original, otherCase);
      expect(await deps.sameFilePathAlias?.(original, otherCase)).toBe(false);
    }

    if (process.platform !== 'win32') {
      const symlink = path.join(root, 'alias.mp4');
      fs.symlinkSync(original, symlink);
      expect(await deps.sameFilePathAlias?.(original, symlink)).toBe(false);
    }
  });
});
