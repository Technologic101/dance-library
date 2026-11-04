import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectHealth } from './health';

const directories: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dance-library-health-'));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('collectHealth', () => {
  it('reports the app version, a migrated catalog, ffprobe, and disabled updates', async () => {
    const dir = tempDir();
    const health = await collectHealth('0.0.1', dir);
    expect(health.appVersion).toBe('0.0.1');
    expect(health.autoUpdate).toBe('disabled');
    expect(health.database.ok).toBe(true);
    expect(health.database.schemaVersion).toBe(3);
    expect(health.database.path).toBe(path.join(dir, 'catalog.sqlite'));
    expect(health.ffprobe.ok).toBe(true);
    if (health.ffprobe.ok) expect(health.ffprobe.version.length).toBeGreaterThan(0);

    const again = await collectHealth('0.0.1', dir);
    expect(again.database.ok).toBe(true);
  }, 20_000);

  it('keeps ffprobe when the database directory cannot be created', async () => {
    const dir = tempDir();
    const blocker = path.join(dir, 'not-a-directory');
    fs.writeFileSync(blocker, 'x');
    const health = await collectHealth('9.9.9', blocker);
    expect(health.appVersion).toBe('9.9.9');
    expect(health.database.ok).toBe(false);
    expect(health.database.error).toBeTruthy();
    expect(health.ffprobe.ok).toBe(true);
    expect(health.autoUpdate).toBe('disabled');
  });
});
