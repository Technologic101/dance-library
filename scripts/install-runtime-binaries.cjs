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
