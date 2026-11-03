import { useEffect, useState } from 'react';
import type { AppHealth } from '../shared/api';

export function App() {
  const [health, setHealth] = useState<AppHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const api = window.danceLibrary;
    if (!api) {
      setError('Preload API is unavailable');
      return;
    }
    api
      .getHealth()
      .then((result) => {
        if (active) setHealth(result);
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!health && !error) return;
    void window.danceLibrary?.notifyHealthShown();
  }, [health, error]);

  return (
    <main>
      <h1>Dance Library</h1>
      <p className="lede">Phase 0 skeleton. Nothing is indexed yet.</p>
      {!health && !error ? <p role="status">Checking the runtime…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {health ? <HealthDetails health={health} /> : null}
      <p className="policy">
        References only. This app never moves, modifies, or deletes video files.
      </p>
    </main>
  );
}

function HealthDetails({ health }: { health: AppHealth }) {
  const database = health.database.ok
    ? `OK, schema ${health.database.schemaVersion}`
    : `Failed: ${health.database.error ?? 'unknown error'}`;
  const ffprobe = health.ffprobe.ok ? health.ffprobe.version : `Failed: ${health.ffprobe.error}`;

  return (
    <dl>
      <div>
        <dt>App version</dt>
        <dd>{health.appVersion}</dd>
      </div>
      <div>
        <dt>Database</dt>
        <dd className={health.database.ok ? 'ok' : 'bad'}>{database}</dd>
      </div>
      <div>
        <dt>Database path</dt>
        <dd>{health.database.path}</dd>
      </div>
      <div>
        <dt>ffprobe</dt>
        <dd className={health.ffprobe.ok ? 'ok' : 'bad'}>{ffprobe}</dd>
      </div>
      <div>
        <dt>Updates</dt>
        <dd>Disabled</dd>
      </div>
    </dl>
  );
}
