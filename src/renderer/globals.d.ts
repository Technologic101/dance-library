import type { DanceLibraryApi } from '../shared/api';

declare global {
  interface Window {
    danceLibrary?: DanceLibraryApi;
  }
}

export {};
