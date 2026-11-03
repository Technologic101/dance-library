import { createHash } from 'node:crypto';
import fs from 'node:fs';

export const CONTENT_HASH_KIND = 'sha256-head-tail-v1';
export const DEFAULT_HASH_CHUNK = 1024 * 1024;

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

function sizeNumber(size: number | bigint): number {
  const value = typeof size === 'bigint' ? Number(size) : size;
  if (!Number.isSafeInteger(value)) throw new Error('File is too large to hash safely');
  return value;
}
