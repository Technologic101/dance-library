// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppHealth } from '../shared/api';
import { App } from './App';

const sample: AppHealth = {
  appVersion: '0.0.1',
  database: { ok: true, schemaVersion: 1, path: '/tmp/catalog.sqlite' },
  ffprobe: { ok: true, version: 'n7.1' },
  autoUpdate: 'disabled',
};

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  window.danceLibrary = {
    getHealth: async () => sample,
    notifyHealthShown: async () => {},
  };
});

describe('App', () => {
  it('shows a loading status and then the runtime check', async () => {
    let resolveHealth: (health: AppHealth) => void = () => {};
    const notify = vi.fn(async () => {});
    window.danceLibrary = {
      getHealth: () =>
        new Promise((resolve) => {
          resolveHealth = resolve;
        }),
      notifyHealthShown: notify,
    };

    render(<App />);
    expect(screen.getByRole('status').textContent).toMatch(/checking/i);

    resolveHealth(sample);
    expect(await screen.findByText('0.0.1')).toBeTruthy();
    expect(screen.getByText('OK, schema 1')).toBeTruthy();
    expect(screen.getByText('/tmp/catalog.sqlite')).toBeTruthy();
    expect(screen.getByText('n7.1')).toBeTruthy();
    expect(screen.getByText('Disabled')).toBeTruthy();
    expect(screen.getByText(/never moves, modifies, or deletes/i)).toBeTruthy();
    await waitFor(() => expect(notify).toHaveBeenCalledOnce());
  });

  it('shows database and ffprobe failures', async () => {
    window.danceLibrary = {
      getHealth: async () => ({
        ...sample,
        database: { ok: false, schemaVersion: 0, path: '/tmp/catalog.sqlite', error: 'disk full' },
        ffprobe: { ok: false, version: null, error: 'not found' },
      }),
      notifyHealthShown: async () => {},
    };
    render(<App />);
    expect(await screen.findByText('Failed: disk full')).toBeTruthy();
    expect(screen.getByText('Failed: not found')).toBeTruthy();
  });

  it('shows an alert when the preload API is missing', async () => {
    window.danceLibrary = undefined;
    render(<App />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/preload/i);
  });

  it('shows an alert when the health check rejects', async () => {
    const notify = vi.fn(async () => {});
    window.danceLibrary = {
      getHealth: async () => {
        throw new Error('IPC down');
      },
      notifyHealthShown: notify,
    };
    render(<App />);
    expect((await screen.findByRole('alert')).textContent).toBe('IPC down');
    await waitFor(() => expect(notify).toHaveBeenCalledOnce());
  });
});
