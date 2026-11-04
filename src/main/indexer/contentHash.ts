import { createHash } from 'node:crypto';
import fs from 'node:fs';

export const CONTENT_HASH_KIND = 'sha256-head-tail-v1';
export const FULL_HASH_KIND = 'sha256-full-v1';
export const DEFAULT_HASH_CHUNK = 1024 * 1024;

/** Files this size or smaller are fully covered by the partial hash. */
export function partialHashCoversFile(size: number, chunkBytes = DEFAULT_HASH_CHUNK): boolean {
  return size >= 0 && size <= chunkBytes * 2;
}

export type ContentHash = {
  hash: string;
  kind: string;
  size: number;
};

/**
 * SHA-256 of the file size plus the first and last chunk. Files that fit in
 * two chunks are hashed in full so a one-byte edit still changes the hash.
 * The file is opened read-only.
 */
export async function partialContentHash(
  filePath: string,
  chunkBytes = DEFAULT_HASH_CHUNK,
): Promise<ContentHash> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const size = sizeNumber(stat.size);
    const hash = createHash('sha256');
    hash.update(Buffer.from(String(size), 'utf8'));
    hash.update(Buffer.from([0]));
    if (size <= chunkBytes * 2) {
      const buffer = Buffer.alloc(size);
      if (size > 0) await handle.read(buffer, 0, size, 0);
      hash.update(buffer);
    } else {
      const head = Buffer.alloc(chunkBytes);
      const tail = Buffer.alloc(chunkBytes);
      await handle.read(head, 0, chunkBytes, 0);
      await handle.read(tail, 0, chunkBytes, size - chunkBytes);
      hash.update(head);
      hash.update(tail);
    }
    return { hash: hash.digest('hex'), kind: CONTENT_HASH_KIND, size };
  } finally {
    await handle.close();
  }
}

/** SHA-256 of every byte. The file is opened read-only. */
export async function fullContentHash(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(DEFAULT_HASH_CHUNK);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead <= 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

function sizeNumber(size: number | bigint): number {
  const value = typeof size === 'bigint' ? Number(size) : size;
  if (!Number.isSafeInteger(value)) throw new Error('File is too large to hash safely');
  return value;
}
