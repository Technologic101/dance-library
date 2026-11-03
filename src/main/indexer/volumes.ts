import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathsEqual } from './paths';

const execFileAsync = promisify(execFile);

export type Mount = {
  volumeId: string;
  /** Mount point. On Windows this is a drive root such as `D:\`. */
  root: string;
};

export type VolumeLocation = {
  volumeId: string;
  root: string;
  /** Path relative to the mount point, using forward slashes. */
  relPath: string;
};

export type ResolvedLibrary = {
  availability: 'online' | 'offline';
  path: string;
  volumeId: string | null;
  volumeRelPath: string | null;
};

const SKIP_LINUX_FS = new Set([
  'autofs',
  'binfmt_misc',
  'bpf',
  'cgroup',
  'cgroup2',
  'configfs',
  'debugfs',
  'devpts',
  'devtmpfs',
  'efivarfs',
  'fusectl',
  'hugetlbfs',
  'mqueue',
  'nsfs',
  'proc',
  'pstore',
  'rpc_pipefs',
  'securityfs',
  'sysfs',
  'tracefs',
]);

type MountInfo = {
  majorMinor: string;
  mountPoint: string;
  source: string;
  fsType: string;
};

/**
 * Finds a library folder after its drive letter or mount point changes.
 * The saved volume id wins over a different disk that now occupies the old path.
 */
export function resolveLibraryPath(
  library: { path: string; volumeId: string | null; volumeRelPath: string | null },
  mounts: readonly Mount[],
  io: {
    existsDir: (candidate: string) => boolean;
    describe: (candidate: string) => VolumeLocation | null;
  },
): ResolvedLibrary {
  const savedExists = io.existsDir(library.path);
  const described = savedExists ? io.describe(library.path) : null;

  if (savedExists && !library.volumeId) {
    return {
      availability: 'online',
      path: library.path,
      volumeId: described?.volumeId ?? null,
      volumeRelPath: described?.relPath ?? null,
    };
  }

  if (described && library.volumeId && described.volumeId === library.volumeId) {
    return {
      availability: 'online',
      path: library.path,
      volumeId: described.volumeId,
      volumeRelPath: described.relPath,
    };
  }

  if (library.volumeId && library.volumeRelPath != null) {
    const relocated = locateRelPath(
      library.volumeId,
      library.volumeRelPath,
      mounts,
      io.existsDir,
      library.path,
    );
    if (relocated) {
      return {
        availability: 'online',
        path: relocated,
        volumeId: library.volumeId,
        volumeRelPath: library.volumeRelPath,
      };
    }
  }

  return {
    availability: 'offline',
    path: library.path,
    volumeId: library.volumeId,
    volumeRelPath: library.volumeRelPath,
  };
}

export function locateRelPath(
  volumeId: string,
  relPath: string,
  mounts: readonly Mount[],
  existsDir: (candidate: string) => boolean,
  preferred?: string,
): string | null {
  const found: string[] = [];
  for (const mount of mounts) {
    if (mount.volumeId !== volumeId) continue;
    const candidate = joinVolume(mount.root, relPath);
    if (existsDir(candidate)) found.push(candidate);
  }
  if (preferred) {
    const match = found.find((candidate) => pathsEqual(candidate, preferred));
    if (match) return match;
  }
  return found[0] ?? null;
}

export function joinVolume(root: string, relPosix: string): string {
  const parts = relPosix.split('/').filter((part) => part.length > 0);
  const windows = /^[A-Za-z]:[\\/]/.test(root) || root.includes('\\');
  if (parts.length === 0) return root;
  return (windows ? path.win32.join : path.posix.join)(root, ...parts);
}

export function windowsVolumeIdFromSerial(serial: bigint): string {
  return `vol:${(serial & 0xffffffffn).toString(16).padStart(8, '0')}`;
}

export function parseWindowsVolumeCsv(csv: string): Mount[] {
  const lines = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const mounts: Mount[] = [];
  for (const line of lines.slice(1)) {
    const [device, serial] = parseCsvLine(line);
    if (!device || !serial) continue;
    const letter = device.replaceAll('"', '').replace(':', '').trim();
    const hex = serial.replaceAll('"', '').replace(/-/g, '').trim().toLowerCase();
    if (!/^[A-Za-z]$/.test(letter) || !/^[0-9a-f]+$/.test(hex)) continue;
    mounts.push({
      volumeId: `vol:${hex.padStart(8, '0').slice(-8)}`,
      root: `${letter.toUpperCase()}:\\`,
    });
  }
  return mounts;
}

export function parseMountinfo(text: string): MountInfo[] {
  const mounts: MountInfo[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parsed = parseMountinfoLine(line);
    if (parsed) mounts.push(parsed);
  }
  return mounts;
}

export function parseDiskutilMounts(text: string): Mount[] {
  const mounts: Mount[] = [];
  let uuid: string | null = null;
  let root: string | null = null;
  let started = false;
  const flush = () => {
    if (uuid && root && root.startsWith('/')) mounts.push({ volumeId: `uuid:${uuid}`, root });
    uuid = null;
    root = null;
    started = false;
  };
  for (const line of text.split('\n')) {
    if (line.includes('***')) {
      flush();
      continue;
    }
    // diskutil leaves blank lines inside a volume, and starts the next one
    // with a new device line. Don't drop a UUID just because a line was blank.
    if (/^\s*Device (?:Node|Identifier):/.test(line)) {
      if (started) flush();
      started = true;
      continue;
    }
    const uuidMatch = /^\s*Volume UUID:\s+(\S+)/.exec(line);
    if (uuidMatch?.[1] && uuidMatch[1] !== 'Not') {
      uuid = uuidMatch[1];
      started = true;
    }
    const mountMatch = /^\s*Mount Point:\s+(.+)\s*$/.exec(line);
    if (mountMatch?.[1]) {
      root = mountMatch[1].trim();
      started = true;
    }
  }
  flush();
  return mounts;
}

export function describeWindowsPath(
  filePath: string,
  mounts: readonly Mount[],
): VolumeLocation | null {
  const parsed = path.win32.parse(filePath);
  const mount = mounts.find((item) => item.root.toLowerCase() === parsed.root.toLowerCase());
  if (!mount) return null;
  const rel = path.win32.relative(parsed.root, filePath).split('\\').join('/');
  return { volumeId: mount.volumeId, root: mount.root, relPath: rel === '' ? '' : rel };
}

export function describePosixPath(
  filePath: string,
  mounts: readonly Mount[],
): VolumeLocation | null {
  let best: Mount | null = null;
  for (const mount of mounts) {
    if (!isInsidePosix(mount.root, filePath)) continue;
    if (!best || mount.root.length > best.root.length) best = mount;
  }
  if (!best) return null;
  let rel = filePath.slice(best.root.length);
  if (rel.startsWith('/')) rel = rel.slice(1);
  return { volumeId: best.volumeId, root: best.root, relPath: rel };
}

export function describePath(filePath: string, mounts: readonly Mount[]): VolumeLocation | null {
  if (process.platform === 'win32')
    return describeWindowsPath(path.win32.normalize(filePath), mounts);
  return describePosixPath(path.resolve(filePath), mounts);
}

export async function listMounts(): Promise<Mount[]> {
  try {
    if (process.platform === 'win32') return await listWindowsMounts();
    if (process.platform === 'darwin') return await listMacMounts();
    return listLinuxMounts();
  } catch (error) {
    console.error('[dance-library] volume listing failed', error);
    return [];
  }
}

async function listWindowsMounts(): Promise<Mount[]> {
  // Network drives are omitted. Asking Windows about a disconnected mapped
  // drive can stall the process. USB and local disks still return.
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DriveType != 4" | Select-Object DeviceID, VolumeSerialNumber | ConvertTo-Csv -NoTypeInformation',
    ],
    { windowsHide: true, timeout: 15_000 },
  );
  return parseWindowsVolumeCsv(stdout);
}

async function listMacMounts(): Promise<Mount[]> {
  try {
    const { stdout } = await execFileAsync('diskutil', ['info', '-all'], { timeout: 20_000 });
    const mounts = parseDiskutilMounts(stdout);
    if (mounts.length > 0) return mounts;
  } catch (error) {
    console.error('[dance-library] diskutil failed', error);
  }
  return [];
}

function listLinuxMounts(): Mount[] {
  const text = fs.readFileSync('/proc/self/mountinfo', 'utf8');
  const uuids = readLinuxUuidMap();
  const mounts: Mount[] = [];
  for (const info of parseMountinfo(text)) {
    if (SKIP_LINUX_FS.has(info.fsType)) continue;
    if (!info.mountPoint.startsWith('/')) continue;
    const realSource = resolveDevice(info.source);
    const uuid = realSource ? uuids.get(realSource) : undefined;
    mounts.push({
      volumeId: uuid ? `uuid:${uuid}` : `dev:${info.majorMinor}`,
      root: info.mountPoint,
    });
  }
  return mounts;
}

function readLinuxUuidMap(): Map<string, string> {
  const map = new Map<string, string>();
  const dir = '/dev/disk/by-uuid';
  if (!fs.existsSync(dir)) return map;
  for (const name of fs.readdirSync(dir)) {
    try {
      map.set(fs.realpathSync(path.join(dir, name)), name);
    } catch {
      // A disk can disappear between the listing and the read.
    }
  }
  return map;
}

function resolveDevice(source: string): string | null {
  if (!source.startsWith('/dev/')) return null;
  try {
    return fs.realpathSync(source);
  } catch {
    return null;
  }
}

function parseMountinfoLine(line: string): MountInfo | null {
  const parts = line.split(' ');
  const separator = parts.indexOf('-');
  if (separator < 6) return null;
  const majorMinor = parts[2];
  const mountPoint = parts[4];
  const fsType = parts[separator + 1];
  const source = parts[separator + 2];
  if (!majorMinor || !mountPoint || !fsType || !source) return null;
  return {
    majorMinor,
    mountPoint: unescapeMount(mountPoint),
    source: unescapeMount(source),
    fsType,
  };
}

function unescapeMount(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function isInsidePosix(root: string, target: string): boolean {
  const normalRoot = root.length > 1 && root.endsWith('/') ? root.slice(0, -1) : root;
  if (target === normalRoot) return true;
  const prefix = normalRoot === '/' ? '/' : `${normalRoot}/`;
  return target.startsWith(prefix);
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted && char === '"' && line[index + 1] === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === ',' && !quoted) {
      values.push(current.trim());
      current = '';
      continue;
    }
    current += char ?? '';
  }
  values.push(current.trim());
  return values;
}
