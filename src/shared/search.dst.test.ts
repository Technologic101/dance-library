import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('local day bounds in Los Angeles', () => {
  it("uses each date's own offset, including a DST change", () => {
    const result = spawnSync(
      process.execPath,
      [path.join(import.meta.dirname, 'dstBounds.check.mjs')],
      {
        env: { ...process.env, TZ: 'America/Los_Angeles' },
        encoding: 'utf8',
      },
    );
    expect(result.status, result.stderr || result.stdout || '').toBe(0);
  });
});
