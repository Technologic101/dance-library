import type Database from 'better-sqlite3';

type MergeState = { sequence: number; videos: Map<string, number> };

const mergeStates = new WeakMap<Database.Database, MergeState>();

function stateFor(db: Database.Database): MergeState {
  let state = mergeStates.get(db);
  if (!state) {
    state = { sequence: 0, videos: new Map() };
    mergeStates.set(db, state);
  }
  return state;
}

export function currentMergeSequence(db: Database.Database, videoId: string): number {
  return stateFor(db).videos.get(videoId) ?? 0;
}

export function recordMergeInto(db: Database.Database, videoId: string): void {
  const state = stateFor(db);
  state.sequence++;
  state.videos.set(videoId, state.sequence);
}
