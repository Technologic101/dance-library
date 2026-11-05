import fs from 'node:fs';
import path from 'node:path';
import { ensureExecutable, resolveBundledTool } from '../binaries';
import { runProcess } from './process';

const THUMBNAIL_TIMEOUT_MS = 30_000;

export function thumbnailFileName(videoId: string): string {
  return `${videoId}.jpg`;
}

export function seekSeconds(durationMs: number | null): number {
  if (durationMs == null || durationMs <= 0) return 0;
  const seconds = durationMs / 1000;
  if (seconds <= 0.5) return 0;
  return Math.min(1, seconds / 2);
}

export function thumbnailArgs(input: string, output: string, seek: number): string[] {
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    seek.toFixed(3),
    '-i',
    input,
    '-frames:v',
    '1',
    '-vf',
    'scale=480:-2',
    '-q:v',
    '4',
    '-update',
    '1',
    output,
  ];
}

/**
 * Writes a JPEG into the thumbnail directory. The source video is only read.
 * Returns true when a JPEG was written.
 */
export async function writeThumbnail(
  filePath: string,
  destPath: string,
  durationMs: number | null,
): Promise<boolean> {
  let binary: string;
  try {
    binary = resolveBundledTool('ffmpeg');
    ensureExecutable(binary);
  } catch {
    return false;
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const seek = seekSeconds(durationMs);
  const wrote = await extractFrame(binary, filePath, destPath, seek);
  if (wrote || seek === 0) return wrote;
  return extractFrame(binary, filePath, destPath, 0);
}

async function extractFrame(
  binary: string,
  filePath: string,
  destPath: string,
  seek: number,
): Promise<boolean> {
  // The name has to end in .jpg. ffmpeg picks the image codec from the extension.
  const temporary = path.join(path.dirname(destPath), `.${path.basename(destPath)}.partial.jpg`);
  fs.rmSync(temporary, { force: true });
  const result = await runProcess(
    binary,
    thumbnailArgs(filePath, temporary, seek),
    THUMBNAIL_TIMEOUT_MS,
  );
  if (result.timedOut || result.code !== 0 || !fs.existsSync(temporary)) {
    fs.rmSync(temporary, { force: true });
    return false;
  }
  const header = Buffer.alloc(3);
  const handle = await fs.promises.open(temporary, 'r');
  try {
    await handle.read(header, 0, 3, 0);
  } finally {
    await handle.close();
  }
  if (header[0] !== 0xff || header[1] !== 0xd8 || header[2] !== 0xff) {
    fs.rmSync(temporary, { force: true });
    return false;
  }
  fs.renameSync(temporary, destPath);
  return true;
}
