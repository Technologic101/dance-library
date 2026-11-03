import fs from 'node:fs';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  type MessageBoxOptions,
  type OpenDialogOptions,
} from 'electron';
import started from 'electron-squirrel-startup';
import {
  IpcChannels,
  type AddLibrariesResult,
  type AppHealth,
  type RemoveLibraryResult,
  type ScanProgress,
  type ScanSummary,
} from '../shared/api';
import { collectHealth } from './health';
import { createLibraryService, type LibraryService } from './libraryService';
import { catalogPath, openCatalog } from './db/catalog';
import { handleThumbProtocol, registerThumbScheme } from './thumbsProtocol';

if (started) app.quit();

// Stable folder name. The installer display name stays "Dance Library".
app.setName('dance-library');
registerThumbScheme();

const userDataOverride = process.env.DANCE_LIBRARY_USER_DATA;
if (userDataOverride) app.setPath('userData', path.resolve(userDataOverride));

const screenshotPath = process.env.DANCE_LIBRARY_SCREENSHOT
  ? path.resolve(process.env.DANCE_LIBRARY_SCREENSHOT)
  : undefined;
const importPath = process.env.DANCE_LIBRARY_IMPORT
  ? path.resolve(process.env.DANCE_LIBRARY_IMPORT)
  : undefined;

let screenshotTimer: ReturnType<typeof setTimeout> | undefined;
let capturing = false;
let catalogDb: ReturnType<typeof openCatalog> | undefined;

const createWindow = () => {
  const devServerUrl = rendererDevServerUrl();
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    backgroundColor: '#1b1614',
    title: 'Dance Library',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (devServerUrl && url.startsWith(devServerUrl)) return;
    event.preventDefault();
  });
  mainWindow.webContents.on('console-message', (event) => {
    console.log(`[renderer] ${event.message}`);
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    console.error(`[dance-library] failed to load window: ${code} ${description}`);
  });

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    const rendererName =
      typeof MAIN_WINDOW_VITE_NAME === 'string' ? MAIN_WINDOW_VITE_NAME : 'main_window';
    void mainWindow.loadFile(path.join(__dirname, `../renderer/${rendererName}/index.html`));
  }
};

function broadcastProgress(progress: ScanProgress): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IpcChannels.scanProgress, progress);
  }
}

function registerIpc(service: LibraryService): void {
  ipcMain.handle(IpcChannels.getHealth, async (): Promise<AppHealth> => {
    const health = await collectHealth(app.getVersion(), app.getPath('userData'), catalogDb);
    const ffprobe = health.ffprobe.ok ? health.ffprobe.version : health.ffprobe.error;
    console.log(
      `[dance-library] version ${health.appVersion} database=${health.database.ok} ffprobe=${ffprobe}`,
    );
    return health;
  });

  ipcMain.handle(IpcChannels.listLibraries, () => service.listLibraries());
  ipcMain.handle(IpcChannels.listVideos, () => service.listVideos());

  ipcMain.handle(IpcChannels.addLibraries, async (): Promise<AddLibrariesResult> => {
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options: OpenDialogOptions = {
      title: 'Add library folder',
      buttonLabel: 'Add folder',
      properties: ['openDirectory', 'multiSelections'],
    };
    const picked = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length === 0) {
      return { added: [], skipped: [], scan: null };
    }
    return service.addPaths(picked.filePaths, broadcastProgress);
  });

  ipcMain.handle(
    IpcChannels.removeLibrary,
    async (_event, libraryId: unknown): Promise<RemoveLibraryResult> => {
      if (typeof libraryId !== 'string' || libraryId.length === 0) {
        return { ok: false, message: 'Missing library id.' };
      }
      const library = service.listLibraries().find((item) => item.id === libraryId);
      if (!library) return { ok: false, message: 'That folder is not in the catalog.' };
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const options: MessageBoxOptions = {
        type: 'question',
        buttons: ['Remove from catalog', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Remove library folder',
        message: `Remove "${library.label}" from the catalog?`,
        detail:
          'Catalog entries and thumbnails for this folder are deleted. The video files stay where they are.',
      };
      const confirm = parent
        ? await dialog.showMessageBox(parent, options)
        : await dialog.showMessageBox(options);
      if (confirm.response !== 0) return { ok: false, message: 'Cancelled.' };
      const removed = await service.removeLibrary(libraryId);
      return removed ? { ok: true } : { ok: false, message: 'That folder is not in the catalog.' };
    },
  );

  ipcMain.handle(IpcChannels.scanLibrary, (_event, libraryId: unknown): Promise<ScanSummary> => {
    if (typeof libraryId !== 'string' || libraryId.length === 0) {
      return Promise.reject(new Error('Missing library id.'));
    }
    return service.scanLibrary(libraryId, broadcastProgress);
  });

  ipcMain.handle(IpcChannels.scanAll, (): Promise<ScanSummary> => {
    return service.scanAll(broadcastProgress);
  });

  ipcMain.handle(IpcChannels.viewReady, async (event) => {
    if (!screenshotPath || capturing) return;
    capturing = true;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    if (screenshotTimer) clearTimeout(screenshotTimer);
    await new Promise((resolve) => setTimeout(resolve, 400));
    try {
      const image = await window.webContents.capturePage();
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      fs.writeFileSync(screenshotPath, image.toPNG());
      console.log(`[dance-library] wrote screenshot ${screenshotPath}`);
      app.exit(0);
    } catch (error) {
      console.error('[dance-library] screenshot failed', error);
      app.exit(1);
    }
  });
}

function installProductionHeaders(): void {
  if (rendererDevServerUrl()) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' dance-thumb:",
        ],
      },
    });
  });
}

function rendererDevServerUrl(): string | undefined {
  if (typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'string') return undefined;
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL.length === 0) return undefined;
  return MAIN_WINDOW_VITE_DEV_SERVER_URL;
}

void app.whenReady().then(async () => {
  installProductionHeaders();
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });

  const userData = app.getPath('userData');
  catalogDb = openCatalog(catalogPath(userData));
  const thumbsDir = path.join(userData, 'thumbnails');
  const service = createLibraryService(catalogDb, thumbsDir);
  handleThumbProtocol(thumbsDir);
  registerIpc(service);

  if (importPath) {
    try {
      const result = await service.addPaths([importPath], (progress) => {
        console.log(`[dance-library] ${progress.message}`);
      });
      const discovered = result.scan?.discovered ?? 0;
      const errors = result.scan?.errors ?? 0;
      console.log(
        `[dance-library] import added=${result.added.length} discovered=${discovered} errors=${errors}`,
      );
      for (const skipped of result.skipped) {
        console.error(`[dance-library] import skipped ${skipped.path}: ${skipped.message}`);
      }
    } catch (error) {
      console.error('[dance-library] import failed', error);
    }
  }

  createWindow();

  if (screenshotPath) {
    screenshotTimer = setTimeout(
      () => {
        console.error('[dance-library] screenshot timed out before the window was ready');
        app.exit(1);
      },
      importPath ? 120_000 : 30_000,
    );
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  catalogDb?.close();
});
