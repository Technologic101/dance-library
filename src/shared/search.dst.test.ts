import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('local day bounds in Los Angeles', () => {
  it("uses each date's own offset, including a DST change", () => {
    const result = spawnSync(
      'npx',
      ['vite-node', path.join(import.meta.dirname, 'dstBounds.check.ts')],
      {
        cwd: path.resolve(import.meta.dirname, '../..'),
        env: { ...process.env, TZ: 'America/Los_Angeles' },
        encoding: 'utf8',
      },
    );
    expect(result.stderr ?? '').toBe('');
    expect(result.stdout ?? '').toBe('');
    expect(result.status).toBe(0);
  });
});
