import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runtimePackagePrefixes, shouldPackagerIgnore } from './ignore';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('shouldPackagerIgnore', () => {
  const prefixes = ['/node_modules/better-sqlite3', '/node_modules/ffmpeg-static'];

  it('keeps the root, vite output, package.json, runtime packages, and their parents', () => {
    expect(shouldPackagerIgnore('', prefixes)).toBe(false);
    expect(shouldPackagerIgnore('/.vite/build/main.js', prefixes)).toBe(false);
    expect(shouldPackagerIgnore('/package.json', prefixes)).toBe(false);
    expect(shouldPackagerIgnore('/node_modules', prefixes)).toBe(false);
    expect(shouldPackagerIgnore('/node_modules/better-sqlite3', prefixes)).toBe(false);
    expect(
      shouldPackagerIgnore('/node_modules/better-sqlite3/build/better_sqlite3.node', prefixes),
    ).toBe(false);
  });

  it('drops native binaries for other operating systems', () => {
    const host = { platform: 'linux', arch: 'x64', musl: false };
    const hostPrefixes = [...prefixes, '/node_modules/@ffprobe-installer/linux-x64'];
    expect(
      shouldPackagerIgnore(
        '/node_modules/better-sqlite3/prebuilds/linux-x64.node',
        hostPrefixes,
        host,
      ),
    ).toBe(false);
    expect(
      shouldPackagerIgnore(
        '/node_modules/better-sqlite3/prebuilds/linux-arm64.node',
        hostPrefixes,
        host,
      ),
    ).toBe(true);
    expect(
      shouldPackagerIgnore(
        '/node_modules/better-sqlite3/prebuilds/win32-x64.node',
        hostPrefixes,
        host,
      ),
    ).toBe(true);
    expect(
      shouldPackagerIgnore(
        '/node_modules/@ffprobe-installer/linux-x64/ffprobe',
        hostPrefixes,
        host,
      ),
    ).toBe(false);
    expect(
      shouldPackagerIgnore(
        '/node_modules/@ffprobe-installer/darwin-arm64/ffprobe',
        hostPrefixes,
        host,
      ),
    ).toBe(true);
  });

  it('drops source, docs, and lookalike package names', () => {
    expect(shouldPackagerIgnore('/src/main/index.ts', prefixes)).toBe(true);
    expect(shouldPackagerIgnore('/README.md', prefixes)).toBe(true);
    expect(shouldPackagerIgnore('/node_modules/electron/cli.js', prefixes)).toBe(true);
    expect(shouldPackagerIgnore('/node_modules/better-sqlite3-extra/index.js', prefixes)).toBe(
      true,
    );
  });
});

describe('runtimePackagePrefixes', () => {
  it('includes the catalog and media binaries and excludes the dev toolchain', () => {
    const prefixes = runtimePackagePrefixes(projectRoot);
    expect(prefixes.some((prefix) => prefix.endsWith('/better-sqlite3'))).toBe(true);
    expect(prefixes.some((prefix) => prefix.endsWith('/ffmpeg-static'))).toBe(true);
    expect(prefixes.some((prefix) => prefix.includes('@ffprobe-installer'))).toBe(true);
    expect(shouldPackagerIgnore('/node_modules/electron/cli.js', prefixes)).toBe(true);
    expect(shouldPackagerIgnore('/node_modules/vite/dist/node/index.js', prefixes)).toBe(true);
    expect(shouldPackagerIgnore('/.vite/renderer/main_window/index.html', prefixes)).toBe(false);
  });
});

describe('release wiring', () => {
  it('does not publish or sign from the forge config', () => {
    const source = fs.readFileSync(path.join(projectRoot, 'forge.config.ts'), 'utf8');
    expect(source).not.toMatch(/publishers\s*:/);
    expect(source).not.toMatch(/osxSign|osxNotarize|certificateFile|certificatePassword/);
  });

  it('keeps CI to lint, test, and unsigned installers', () => {
    const source = fs.readFileSync(path.join(projectRoot, '.github/workflows/ci.yml'), 'utf8');
    expect(source).toMatch(/npm run lint/);
    expect(source).toMatch(/npm test/);
    expect(source).toMatch(/npm run make/);
    expect(source).toMatch(/windows-latest/);
    expect(source).toMatch(/macos-latest/);
    expect(source).toMatch(/upload-artifact/);
    expect(source).not.toMatch(/gh release|action-gh-release|electron-forge publish/i);
    expect(source).not.toMatch(/contents:\s*write/);
  });
});
