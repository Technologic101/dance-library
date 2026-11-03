# Dance Library

A small desktop app for cataloging a personal dance video library (zouk, kizomba and other social styles): lessons, post-lesson demos, social dances and performances. It indexes videos where they already live, on a local or external drive and in a Google Photos Takeout export, helps consolidate them into one library, and gives a fast way to find, tag and practice with them. Intended to be open source and installable by anyone, with no Python, Node or other setup required.

> Status: Phase 0 skeleton is implemented. An unsigned build opens a window and reports the app version, SQLite catalog health, and bundled ffprobe version. Phases 1–6 are not built. Auto-update is not active. The sections below are still the plan.

## Developer setup

Phase 0 is an Electron app. People who install a packaged build do not need Node. Development uses Node.js 22 or newer and npm.

```bash
npm ci
npm run dev
```

`.npmrc` sets `legacy-peer-deps=true` because current npm cannot resolve Vitest's optional peers. It also sets `ignore-scripts=true` so npm does not compile `better-sqlite3` (the package already ships a prebuild; compiling it fails on GitHub's Windows image). `npm run dev`, `npm test`, and `npm run make` download the Electron and ffmpeg binaries when they are missing.

| Script         | What it does                           |
| -------------- | -------------------------------------- |
| `npm run dev`  | Start the app with the Vite dev server |
| `npm run lint` | ESLint, Prettier, and TypeScript       |
| `npm test`     | Unit tests (Vitest)                    |
| `npm run make` | Unsigned installer for the current OS  |

The catalog file is `catalog.sqlite` in Electron's user-data directory:

- Linux: `~/.config/dance-library/catalog.sqlite`
- macOS: `~/Library/Application Support/dance-library/catalog.sqlite`
- Windows: `%APPDATA%\dance-library\catalog.sqlite`

It stores references and metadata only. The app never moves, modifies, or deletes video files. Schema changes go through the SQL migration runner in `src/main/db`. Drizzle is still optional for later phases.

`better-sqlite3` is loaded from its N-API prebuild in both Node and Electron, so the app does not compile it.

ffmpeg comes from `ffmpeg-static`, and ffprobe from `@ffprobe-installer/ffprobe`. The packager unpacks both from the asar archive so the installed app can execute them. The Linux installer is a `.deb`. An RPM is not built: `electron-installer-redhat` fails on the `rpmbuild` shipped with GitHub-hosted Ubuntu. macOS is a `.zip` of the app. The DMG tool needs a native module that is not compiled while install scripts are disabled. Windows is a Squirrel setup executable. The ffmpeg binary is GPL-3.0-or-later and ffprobe is LGPL-2.1. The project license is still undecided (Phase 6) and has to stay compatible with that before a public release.

Installers are unsigned. Windows SmartScreen and macOS Gatekeeper will warn. Nothing in this repo sets a code-signing certificate, an update feed, or a Forge publisher. GitHub Actions (`.github/workflows/ci.yml`) runs lint, tests, and `npm run make` on Linux, Windows, and macOS, and uploads the unsigned installers as workflow artifacts. It does not create GitHub Releases.

### Download a build from CI

These builds are not GitHub Releases. They sit on the Actions run that produced them.

1. Open the repository on GitHub and go to **Actions**.
2. Open a finished **CI** run (a green check on a pull request or on `main`).
3. Scroll to **Artifacts** at the bottom of that run.
4. Download the zip for your computer: `dance-library-windows-latest`, `dance-library-macos-latest`, or `dance-library-ubuntu-latest`.
5. Unzip that download. The installer is inside.

**Windows.** Run the file whose name ends in `Setup.exe`. SmartScreen says Windows protected your PC. Click **More info**, then **Run anyway**.

**macOS.** Unzip the inner zip so you can see `Dance Library.app`. Right-click the app and choose **Open**, then confirm **Open**. The first double-click is blocked by Gatekeeper; right-click Open is the step that lets an unsigned app start.

**Linux.** Install the `.deb` from the artifact (for example `sudo apt install ./dance-library_*_amd64.deb`).

Debian packages need `fakeroot`. A C++ toolchain is not required for the prebuilt catalog module.

A packaged build can save a picture of the status window and exit. The path comes from the environment, not from the renderer:

```bash
DANCE_LIBRARY_SCREENSHOT=/tmp/dance-library.png \
DANCE_LIBRARY_USER_DATA=/tmp/dance-library-data \
./path/to/dance-library
```

## Why a custom app

Generic photo tools (Immich was considered) handle import and search well, but they aren't lesson-aware: no instructor/level/style fields, no in-video bookmarks, and no practice features like mirroring or slow loops. They also need a Docker server. This app installs like any desktop app and runs entirely on your own computer.

## Principles

- **References, not copies.** The catalog stores file paths and metadata only. Source videos are never modified, moved or deleted by the indexer.
- **Data isn't locked in.** One SQLite file plus a thumbnails folder, with CSV/JSON export.
- **Any file reorganization is opt-in.** Shown as a dry-run plan first, applied only after explicit approval, and reversible through an undo log. Never deletes.

## Planned features (v1)

1. **Indexer** - recursively scans configured source folders (backup drive and extracted Takeout). Records path, filename, size, a fast partial content hash, capture date (from video metadata, Takeout JSON sidecars or filename patterns, falling back to file time), duration, resolution and a thumbnail. Detects duplicates across sources. Re-scans are incremental.
2. **Editable metadata** - video type (lesson, demo, social dance, performance), dance style, instructor(s), level, event/workshop, free tags, notes, rating and favorite, with bulk edit. A lesson and its demo from the same class can be linked. Tag suggestions come from folder names, Takeout album names and filenames, and the user confirms them.
3. **Browse and search** - thumbnail grid and list views, a search box, and filters for date range, video type, style, instructor, level, tags, duration, source and favorites. Pick several videos into a practice playlist.
4. **Practice player** - speed control (0.25x to 2x), mirror toggle, A-B loop, and searchable timestamp bookmarks inside a video ("basic step at 3:12").
5. **Consolidation report** - matches duplicates by content (not filename) across sources and lists videos found in both places, only on the drive, and only in Google, so only the Google-only ones need copying to the drive. Copies happen only after approval; the app never deletes.
6. **Export** - CSV and JSON export of the whole catalog.

## Planned for v1.1

- **Highlight export** - mark an in and out point (reusing the A-B loop markers) and save that section as a new video file with bundled ffmpeg, running in the background with progress. A quick trim snaps to the nearest keyframe; an exact or mirrored export re-encodes. Originals are never modified.
- **Cropping** - draw a crop box over the video and export the cropped region (re-encodes, hardware-accelerated where available).

## Later

- folder-organization proposals (dry run, approve, undo log) and access from a phone on the home network.

## Sources

- **Local or external drives** (primary), such as a backup drive on a Windows PC.
- **Google Photos** via a Google Takeout export of videos; per-video JSON sidecars supply capture dates and album names.

## Architecture (decided so far)

- **Electron desktop app in TypeScript**, packaged as a normal installer for Windows first, then macOS. Electron's bundled Chromium gives consistent video playback across machines.
- **Bundled ffmpeg/ffprobe** for metadata and thumbnails, so users install nothing else.
- **SQLite** catalog database plus a thumbnails folder in the app's data directory.
- **Playback straight from the source file.** External USB drives are fast enough for smooth playback, seeking and slow motion; nothing is copied for viewing.
- **Google Photos via Takeout only.** Google's API no longer allows browsing or streaming a whole library, so videos come in through a Takeout download, which can be processed one zip at a time when disk space is tight.

- **React + Vite** for the UI in the renderer process; it talks to the main process only through a small preload API over IPC.
- **better-sqlite3** in the main process, with SQLite full-text search for titles, tags, notes and bookmarks (Drizzle optional for typed queries and migrations).

- **Electron Forge** builds the Windows installer and macOS app and rebuilds native modules for Electron. Auto-updates come from GitHub Releases through Electron's free update service.
- **Unsigned builds at first** (Windows SmartScreen and macOS Gatekeeper will warn on install); code signing gets added once the app has real users.

## Catalog fields

- **Title** - optional custom title; falls back to the filename.
- **Video type** - lesson, demo, social dance, performance.
- **Style** - picked from a built-in list of common dance styles (Latin, Brazilian, African, ballroom, swing, street, contemporary and more, aiming to cover as many styles as possible), and users can add their own.
- **Instructor(s)** - a user-managed list; add new instructors as you go.
- **Level** - Beginner, Intermediate, Advanced, Master, or All levels.
- **Event or workshop**, **date**, **rating**, **favorite** and **notes**.
- **Free tags** - anything else, such as move names or concepts, with autocomplete to keep them consistent.

## Suggestions, never silent guesses

The app can suggest field values from file metadata, filenames, folder names and Takeout album names, and optionally from a low-cost AI model. Suggestions are always shown as one-click accept or dismiss, never written into the catalog automatically, and AI suggestions are off unless the user turns them on. AI suggestions are planned for after v1 and use the user's own API key, so no videos or data pass through a project-run server. Dismissed suggestions aren't repeated.

## Phased build plan

Each phase ends with something runnable and is tested against a small set of sample videos (various formats, including phone HEVC, plus a fake Takeout export), not any one person's library.

**Phase 0 - Skeleton.** Electron Forge + Vite + React + TypeScript project; secure main/renderer split with a typed preload API; better-sqlite3 wired in and rebuilt for Electron; bundled ffmpeg/ffprobe; schema migrations; lint, unit tests and CI on GitHub Actions building Windows and macOS. _Done when:_ an unsigned installer opens an empty window on both platforms.

**Phase 1 - Library and indexer.** Add or remove source folders; background scan with progress; per-video size, partial hash, duration, resolution, capture date (metadata, filename patterns, file time) and thumbnail; incremental re-scans; missing-file handling when a drive is unplugged. Source files are read-only. _Done when:_ a few thousand sample files index and re-scan quickly.

**Phase 2 - Browse and search.** Thumbnail grid and list, full-text search, filters (date range, type, style, instructor, level, tags, duration, source, favorites), sorting. _Done when:_ filtering a large catalog feels instant.

**Phase 3 - Catalog editing.** Detail panel with all fields (title, type, style, instructors, level, event, date, tags, rating, favorite, notes); built-in style list plus user-added styles and instructors; tag autocomplete; bulk edit; linking a lesson to its demo. _Done when:_ a batch of videos can be fully tagged without leaving the keyboard.

**Phase 4 - Practice player.** Playback from source through a custom file protocol; speed 0.25x to 2x; mirror; A-B loop; frame step; searchable timestamp bookmarks; practice playlists. _Done when:_ smooth slow and mirrored playback from an external drive.

**Phase 5 - Google Photos Takeout and consolidation.** Import extracted Takeout (one zip at a time), reading JSON sidecars for dates and albums; content-based duplicate detection across sources; consolidation report (both, drive only, Google only); approved copy of Google-only videos to a chosen folder with a log. Never deletes. _Done when:_ a sample Takeout reconciles correctly against a sample drive.

**Phase 6 - Suggestions, export and release.** Rule-based suggestions from filenames, folders and albums with one-click accept or dismiss; CSV and JSON export; auto-update via GitHub Releases; README, screenshots and license for open-sourcing. _Done when:_ v1.0 is published as an unsigned release.

**v1.1 and later.** Highlight export and cropping; optional AI suggestions with the user's own API key; folder-organization proposals (dry run, approval, undo log); phone access on the home network; code signing.

**Real-library testing (alongside phases 1 to 5).** A read-only inventory of a real backup drive checks the indexer against real-world files, and that library gets catalogued after Phase 3.
