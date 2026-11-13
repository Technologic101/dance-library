import type Database from 'better-sqlite3';

export type MergedRelations = {
  instructorIds: readonly string[];
  tagIds: readonly string[];
};

type MergeEvent = MergedRelations & { sequence: number };
type MergeState = { sequence: number; videos: Map<string, MergeEvent[]> };

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
  return stateFor(db).videos.get(videoId)?.at(-1)?.sequence ?? 0;
}

export function recordMergeInto(
  db: Database.Database,
  videoId: string,
  relations: MergedRelations,
): void {
  const state = stateFor(db);
  state.sequence++;
  const events = state.videos.get(videoId) ?? [];
  events.push({ sequence: state.sequence, ...relations });
  state.videos.set(videoId, events);
}

export function relationMergedSince(
  db: Database.Database,
  videoId: string,
  sequence: number,
  relation: keyof MergedRelations,
  valueId: string,
): boolean {
  return (stateFor(db).videos.get(videoId) ?? []).some(
    (event) => event.sequence > sequence && event[relation].includes(valueId),
  );
}
