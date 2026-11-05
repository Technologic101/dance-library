/**
 * Dev-only sample clips for exercising the indexer. Uses the bundled ffmpeg.
 * Nothing here is shipped as a user-facing tool.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const outputDir = process.argv[2];
if (!outputDir) {
  console.error('Usage: node scripts/make-sample-videos.cjs <output-directory>');
  process.exit(1);
}

const ffmpeg = require('ffmpeg-static');
if (!ffmpeg) {
  console.error('Bundled ffmpeg is missing. Run npm run install-binaries first.');
  process.exit(1);
}

fs.mkdirSync(outputDir, { recursive: true });

const clips = [
  {
    name: 'lesson-basic.mp4',
    args: [
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=640x360:rate=12:duration=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      '-metadata',
      'creation_time=2024-06-01T15:04:05Z',
    ],
  },
  {
    name: 'social_20240315_193045.mp4',
    args: [
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=1280x720:rate=12:duration=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-an',
      '-metadata',
      'creation_time=2024-03-15T19:30:45Z',
    ],
  },
  {
    name: 'demo-hevc.mp4',
    args: [
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x180:rate=8:duration=1',
      '-c:v',
      'libx265',
      '-pix_fmt',
      'yuv420p',
      '-an',
      '-x265-params',
      'log-level=error',
      '-metadata',
      'creation_time=2023-11-02T18:00:00Z',
    ],
  },
  {
    name: 'workshop.webm',
    args: [
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=480x270:rate=10:duration=1',
      '-c:v',
      'libvpx-vp9',
      '-an',
      '-metadata',
      'creation_time=2022-08-20T21:15:00Z',
    ],
  },
];

for (const clip of clips) {
  const dest = path.join(outputDir, clip.name);
  const result = spawnSync(
    ffmpeg,
    ['-y', '-hide_banner', '-loglevel', 'error', ...clip.args, dest],
    {
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    console.error(result.stderr || `ffmpeg failed for ${clip.name}`);
    process.exit(result.status ?? 1);
  }
  console.log(dest);
}
