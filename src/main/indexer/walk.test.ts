import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { walkVideos } from './walk';

const directories: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dance-library-walk-'));
  directories.push(dir);
  return dir;
}

async function collect(root: string): Promise<string[]> {
  const files: string[] = [];
  for await (const file of walkVideos(root)) files.push(file);
  return files.map((file) => path.relative(root, file).split(path.sep).join('/'));
}

afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('walkVideos', () => {
  it('finds videos and skips hidden directories, system folders, and symlinks', async () => {
    const root = tempDir();
    const outside = tempDir();
    fs.mkdirSync(path.join(root, 'lessons'));
    fs.mkdirSync(path.join(root, '.hidden'));
    fs.mkdirSync(path.join(root, '$RECYCLE.BIN'));
    fs.writeFileSync(path.join(root, 'lessons', 'Clip.MP4'), 'a');
    fs.writeFileSync(path.join(root, 'notes.txt'), 'nope');
    fs.writeFileSync(path.join(root, '.hidden', 'secret.mov'), 'b');
    fs.writeFileSync(path.join(root, '$RECYCLE.BIN', 'gone.mp4'), 'c');
    fs.writeFileSync(path.join(root, '.hidden.mp4'), 'd');
    fs.writeFileSync(path.join(outside, 'elsewhere.mp4'), 'e');

    try {
      fs.symlinkSync(path.join(outside, 'elsewhere.mp4'), path.join(root, 'linked.mp4'));
      fs.symlinkSync(outside, path.join(root, 'linked-dir'));
    } catch {
      // Some Windows setups cannot create symlinks. The other skips still apply.
    }

    const found = await collect(root);
    expect(found).toContain('lessons/Clip.MP4');
    expect(found).toContain('.hidden.mp4');
    expect(found).not.toContain('.hidden/secret.mov');
    expect(found).not.toContain('$RECYCLE.BIN/gone.mp4');
    expect(found).not.toContain('linked.mp4');
    expect(found.some((file) => file.includes('elsewhere'))).toBe(false);
  });
});
