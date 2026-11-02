import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, ipcMain, session } from 'electron';
import started from 'electron-squirrel-startup';
import { IpcChannels, type AppHealth } from '../shared/api';
import { collectHealth } from './health';

if (started) app.quit();

// Stable folder name. The installer display name stays "Dance Library".
app.setName('dance-library');

const userDataOverride = process.env.DANCE_LIBRARY_USER_DATA;
if (userDataOverride) app.setPath('userData', path.resolve(userDataOverride));

const screenshotPath = process.env.DANCE_LIBRARY_SCREENSHOT
  ? path.resolve(process.env.DANCE_LIBRARY_SCREENSHOT)
  : undefined;

let screenshotTimer: ReturnType<typeof setTimeout> | undefined;

const createWindow = () => {
  const devServerUrl = rendererDevServerUrl();
  const mainWindow = new BrowserWindow({
    width: 960,
    height: 640,
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

function registerIpc(): void {
  ipcMain.handle(IpcChannels.getHealth, async (): Promise<AppHealth> => {
    const health = await collectHealth(app.getVersion(), app.getPath('userData'));
    const ffprobe = health.ffprobe.ok ? health.ffprobe.version : health.ffprobe.error;
    console.log(
      `[dance-library] version ${health.appVersion} database=${health.database.ok} ffprobe=${ffprobe}`,
    );
    return health;
  });

  ipcMain.handle(IpcChannels.healthShown, async (event) => {
    if (!screenshotPath) return;
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
        'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self'"],
      },
    });
  });
}

function rendererDevServerUrl(): string | undefined {
  if (typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'string') return undefined;
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL.length === 0) return undefined;
  return MAIN_WINDOW_VITE_DEV_SERVER_URL;
}

void app.whenReady().then(() => {
  installProductionHeaders();
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  registerIpc();
  createWindow();

  if (screenshotPath) {
    screenshotTimer = setTimeout(() => {
      console.error('[dance-library] screenshot timed out before the window reported health');
      app.exit(1);
    }, 20_000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
