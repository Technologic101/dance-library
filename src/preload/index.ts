import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IpcChannels, type DanceLibraryApi, type ScanProgress } from '../shared/api';

const api: DanceLibraryApi = {
  getHealth: () => ipcRenderer.invoke(IpcChannels.getHealth),
  notifyViewReady: () => ipcRenderer.invoke(IpcChannels.viewReady),
  listLibraries: () => ipcRenderer.invoke(IpcChannels.listLibraries),
  listVideos: () => ipcRenderer.invoke(IpcChannels.listVideos),
  addLibraries: () => ipcRenderer.invoke(IpcChannels.addLibraries),
  removeLibrary: (libraryId) => ipcRenderer.invoke(IpcChannels.removeLibrary, libraryId),
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
