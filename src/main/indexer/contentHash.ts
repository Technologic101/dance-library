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
      if (size > 0) {
        const buffer = Buffer.alloc(size);
        await readExact(handle, buffer, 0, size);
        hash.update(buffer);
      }
    } else {
      const head = Buffer.alloc(chunkBytes);
      const tail = Buffer.alloc(chunkBytes);
      await readExact(handle, head, 0, chunkBytes);
      await readExact(handle, tail, size - chunkBytes, chunkBytes);
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
      const bytesRead = await readSome(handle, buffer, position, buffer.length);
      if (bytesRead <= 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

async function readExact(
  handle: fs.promises.FileHandle,
  buffer: Buffer,
  position: number,
  length: number,
): Promise<void> {
  const bytesRead = await readSome(handle, buffer, position, length);
  if (bytesRead !== length) throw new Error('Unexpected end of file while hashing');
}

/** Reads until `length` bytes arrive or the file ends. A short read is not treated as EOF. */
async function readSome(
  handle: fs.promises.FileHandle,
  buffer: Buffer,
  position: number,
  length: number,
): Promise<number> {
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead <= 0) return offset;
    offset += bytesRead;
  }
  return offset;
}

function sizeNumber(size: number | bigint): number {
  const value = typeof size === 'bigint' ? Number(size) : size;
  if (!Number.isSafeInteger(value)) throw new Error('File is too large to hash safely');
  return value;
}
