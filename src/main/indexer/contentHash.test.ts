import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTENT_HASH_KIND, fullContentHash, partialContentHash } from './contentHash';

const directories: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dance-library-hash-'));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('partialContentHash', () => {
  it('hashes a small file in full and ignores nothing in the middle', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'clip.mp4');
    fs.writeFileSync(file, Buffer.from('01234567'));
    const first = await partialContentHash(file, 4);
    fs.writeFileSync(file, Buffer.from('01XX4567'));
    const changed = await partialContentHash(file, 4);
    expect(first.kind).toBe(CONTENT_HASH_KIND);
    expect(first.hash).not.toBe(changed.hash);
    expect(first.size).toBe(8);
  });

  it('uses only the head and tail once the file is larger than two chunks', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'long.mp4');
    const bytes = Buffer.alloc(20, 1);
    bytes.fill(2, 4, 16);
    fs.writeFileSync(file, bytes);
    const original = await partialContentHash(file, 4);

    bytes.fill(9, 4, 16);
    fs.writeFileSync(file, bytes);
    const middle = await partialContentHash(file, 4);
    expect(middle.hash).toBe(original.hash);

    bytes[0] = 3;
    fs.writeFileSync(file, bytes);
    const head = await partialContentHash(file, 4);
    expect(head.hash).not.toBe(original.hash);
    expect(head.size).toBe(20);
  });

  it('hashes the boundary between a covered file and a head-tail file', async () => {
    const dir = tempDir();
    const covered = path.join(dir, 'covered.mp4');
    const longer = path.join(dir, 'longer.mp4');
    const coveredBytes = Buffer.alloc(8, 1);
    coveredBytes[4] = 9;
    fs.writeFileSync(covered, coveredBytes);
    const coveredHash = await partialContentHash(covered, 4);
    coveredBytes[4] = 3;
    fs.writeFileSync(covered, coveredBytes);
    expect((await partialContentHash(covered, 4)).hash).not.toBe(coveredHash.hash);

    const longerBytes = Buffer.alloc(9, 1);
    fs.writeFileSync(longer, longerBytes);
    const longerHash = await partialContentHash(longer, 4);
    longerBytes[4] = 9;
    fs.writeFileSync(longer, longerBytes);
    expect((await partialContentHash(longer, 4)).hash).toBe(longerHash.hash);
    expect(await fullContentHash(covered)).toHaveLength(64);
  });

  it('opens the file read-only', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'clip.mp4');
    fs.writeFileSync(file, Buffer.from('video'));
    fs.chmodSync(file, 0o444);
    const hashed = await partialContentHash(file, 4);
    expect(hashed.size).toBe(5);
    expect(fs.readFileSync(file).toString()).toBe('video');
  });
});
