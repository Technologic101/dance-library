import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { autoUpdateStatus } from './autoUpdate';

describe('autoUpdate', () => {
  it('stays disabled until release publishing exists', () => {
    expect(autoUpdateStatus).toBe('disabled');
  });

  it('does not wire an update feed', () => {
    const source = readFileSync(new URL('./autoUpdate.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('electron-updater');
    expect(source).not.toContain('setFeedURL');
    expect(source).not.toContain('checkForUpdates');
  });
});
