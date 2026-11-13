import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IpcChannels, type DanceLibraryApi, type ScanProgress } from '../shared/api';

const api: DanceLibraryApi = {
  getHealth: () => ipcRenderer.invoke(IpcChannels.getHealth),
  notifyViewReady: () => ipcRenderer.invoke(IpcChannels.viewReady),
  listLibraries: () => ipcRenderer.invoke(IpcChannels.listLibraries),
  listVideos: (options) =>
    ipcRenderer.invoke(IpcChannels.listVideos, options ?? { excluded: false }),
  listFacets: (options) =>
    ipcRenderer.invoke(IpcChannels.listFacets, options ?? { excluded: false }),
  countVideos: () => ipcRenderer.invoke(IpcChannels.countVideos),
  addLibraries: () => ipcRenderer.invoke(IpcChannels.addLibraries),
  removeLibrary: (libraryId) => ipcRenderer.invoke(IpcChannels.removeLibrary, libraryId),
  excludeVideos: (videoIds) => ipcRenderer.invoke(IpcChannels.excludeVideos, videoIds),
  restoreVideos: (videoIds) => ipcRenderer.invoke(IpcChannels.restoreVideos, videoIds),
  getVideoDetails: (videoId) => ipcRenderer.invoke(IpcChannels.getVideoDetails, videoId),
  updateVideo: (videoId, patch) => ipcRenderer.invoke(IpcChannels.updateVideo, videoId, patch),
  bulkUpdateVideos: (videoIds, patch) =>
    ipcRenderer.invoke(IpcChannels.bulkUpdateVideos, videoIds, patch),
  undoLastEdit: () => ipcRenderer.invoke(IpcChannels.undoLastEdit),
  searchCatalogValues: (kind, query) =>
    ipcRenderer.invoke(IpcChannels.searchCatalogValues, kind, query),
  createCatalogValue: (kind, name) =>
    ipcRenderer.invoke(IpcChannels.createCatalogValue, kind, name),
  linkLessonDemo: (lessonId, demoId) =>
    ipcRenderer.invoke(IpcChannels.linkLessonDemo, lessonId, demoId),
  unlinkLessonDemo: (lessonId, demoId) =>
    ipcRenderer.invoke(IpcChannels.unlinkLessonDemo, lessonId, demoId),
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
