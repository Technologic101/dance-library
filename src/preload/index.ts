import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels, type DanceLibraryApi } from '../shared/api';

const api: DanceLibraryApi = {
  getHealth: () => ipcRenderer.invoke(IpcChannels.getHealth),
  notifyHealthShown: () => ipcRenderer.invoke(IpcChannels.healthShown),
};

contextBridge.exposeInMainWorld('danceLibrary', api);
