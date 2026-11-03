/**
 * Downloads the Electron and ffmpeg binaries when install scripts are disabled.
 *
 * .npmrc sets ignore-scripts so npm does not compile better-sqlite3. That
 * package already ships N-API prebuilds. ffprobe is unpacked from
 * @ffprobe-installer and does not need a download step.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function run(scriptPath) {
  const result = spawnSync(process.execPath, [scriptPath], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const electronDir = path.dirname(require.resolve('electron/package.json'));
if (!fs.existsSync(path.join(electronDir, 'path.txt'))) {
  run(path.join(electronDir, 'install.js'));
}

const ffmpegDir = path.dirname(require.resolve('ffmpeg-static/package.json'));
const ffmpegName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
if (!fs.existsSync(path.join(ffmpegDir, ffmpegName))) {
  run(path.join(ffmpegDir, 'install.js'));
}

// electron-winstaller's install script copies 7z-<arch>.exe to 7z.exe.
// Squirrel cannot zip the app without that file, and ignore-scripts skips the copy.
ensureSquirrel7Zip();

function ensureSquirrel7Zip() {
  let packageJson;
  try {
    packageJson = require.resolve('electron-winstaller/package.json');
  } catch {
    return;
  }
  const vendor = path.join(path.dirname(packageJson), 'vendor');
  if (fs.existsSync(path.join(vendor, '7z.exe'))) return;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const exe = path.join(vendor, `7z-${arch}.exe`);
  const dll = path.join(vendor, `7z-${arch}.dll`);
  if (!fs.existsSync(exe) || !fs.existsSync(dll)) {
    if (process.platform === 'win32') {
      console.error(`7-Zip for ${arch} is missing from electron-winstaller`);
      process.exit(1);
    }
    return;
  }
  fs.copyFileSync(exe, path.join(vendor, '7z.exe'));
  fs.copyFileSync(dll, path.join(vendor, '7z.dll'));
}
