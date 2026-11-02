import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  binaryPathFromModule,
  ensureExecutable,
  parseToolVersion,
  readToolVersion,
  resolveBundledTool,
  unpackAsarPath,
} from './binaries';

const directories: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dance-library-bin-'));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('unpackAsarPath', () => {
  it('rewrites an asar path and leaves unpacked or normal paths alone', () => {
    expect(unpackAsarPath('/app/app.asar/node_modules/ffmpeg-static/ffmpeg')).toBe(
      '/app/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg',
    );
    expect(unpackAsarPath('C:\\app\\app.asar\\node_modules\\ffprobe-static\\ffprobe.exe')).toBe(
      'C:\\app\\app.asar.unpacked\\node_modules\\ffprobe-static\\ffprobe.exe',
    );
    expect(unpackAsarPath('/app/app.asar.unpacked/ffmpeg')).toBe('/app/app.asar.unpacked/ffmpeg');
    expect(unpackAsarPath('/usr/bin/ffprobe')).toBe('/usr/bin/ffprobe');
  });
});

describe('binaryPathFromModule', () => {
  it('accepts a string, a path field, or a default export', () => {
    expect(binaryPathFromModule('/opt/ffmpeg', 'ffmpeg')).toBe('/opt/ffmpeg');
    expect(binaryPathFromModule({ path: '/opt/ffprobe' }, 'ffprobe')).toBe('/opt/ffprobe');
    expect(binaryPathFromModule({ default: { path: '/opt/app.asar/ffprobe' } }, 'ffprobe')).toBe(
      '/opt/app.asar.unpacked/ffprobe',
    );
  });

  it('rejects a missing binary', () => {
    expect(() => binaryPathFromModule(null, 'ffmpeg')).toThrow(/ffmpeg binary is missing/);
    expect(() => binaryPathFromModule('', 'ffprobe')).toThrow(/ffprobe binary is missing/);
  });
});

describe('parseToolVersion', () => {
  it('reads the version token from ffmpeg and ffprobe output', () => {
    expect(parseToolVersion('ffprobe version n6.1.1 Copyright (c) 2007-2023', 'ffprobe')).toBe(
      'n6.1.1',
    );
    expect(parseToolVersion('ffmpeg version 7.0.2-static Copyright', 'ffmpeg')).toBe(
      '7.0.2-static',
    );
    expect(parseToolVersion('', 'ffprobe')).toBeNull();
    expect(parseToolVersion('not a version banner', 'ffprobe')).toBeNull();
  });
});

describe('ensureExecutable', () => {
  it('adds user execute permission on posix', () => {
    if (process.platform === 'win32') return;
    const file = path.join(tempDir(), 'tool');
    fs.writeFileSync(file, '');
    fs.chmodSync(file, 0o644);
    ensureExecutable(file);
    expect(fs.statSync(file).mode & 0o111).not.toBe(0);
  });
});

describe('readToolVersion', () => {
  it('reports a missing binary', async () => {
    const result = await readToolVersion(path.join(tempDir(), 'missing'), 'ffprobe');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });
});

describe('bundled binaries', () => {
  it('runs the packaged ffprobe and ffmpeg', async () => {
    const ffprobe = await readToolVersion(resolveBundledTool('ffprobe'), 'ffprobe');
    const ffmpeg = await readToolVersion(resolveBundledTool('ffmpeg'), 'ffmpeg');
    expect(ffprobe.ok).toBe(true);
    expect(ffmpeg.ok).toBe(true);
    if (ffprobe.ok) expect(ffprobe.version).toMatch(/\S+/);
    if (ffmpeg.ok) expect(ffmpeg.version).toMatch(/\S+/);
  }, 20_000);
});
