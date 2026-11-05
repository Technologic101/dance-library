import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IpcChannels, type DanceLibraryApi, type ScanProgress } from '../shared/api';

const api: DanceLibraryApi = {
  getHealth: () => ipcRenderer.invoke(IpcChannels.getHealth),
  notifyViewReady: () => ipcRenderer.invoke(IpcChannels.viewReady),
  listLibraries: () => ipcRenderer.invoke(IpcChannels.listLibraries),
  listVideos: (options) =>
    ipcRenderer.invoke(IpcChannels.listVideos, options ?? { excluded: false }),
  listFacets: () => ipcRenderer.invoke(IpcChannels.listFacets),
  countVideos: () => ipcRenderer.invoke(IpcChannels.countVideos),
  addLibraries: () => ipcRenderer.invoke(IpcChannels.addLibraries),
  removeLibrary: (libraryId) => ipcRenderer.invoke(IpcChannels.removeLibrary, libraryId),
  excludeVideos: (videoIds) => ipcRenderer.invoke(IpcChannels.excludeVideos, videoIds),
  restoreVideos: (videoIds) => ipcRenderer.invoke(IpcChannels.restoreVideos, videoIds),
  scanLibrary: (libraryId) => ipcRenderer.invoke(IpcChannels.scanLibrary, libraryId),
  scanAll: () => ipcRenderer.invoke(IpcChannels.scanAll),
  onScanProgress(listener) {
    const wrapped = (_event: IpcRendererEvent, progress: ScanProgress) => listener(progress);
    ipcRenderer.on(IpcChannels.scanProgress, wrapped);
    return () => {
      ipcRenderer.removeListener(IpcChannels.scanProgress, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('danceLibrary', api);
