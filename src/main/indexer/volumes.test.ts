import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describePath,
  describePosixPath,
  describeWindowsPath,
  joinVolume,
  listMounts,
  parseDiskutilMounts,
  parseMountinfo,
  parseWindowsVolumeCsv,
  resolveLibraryPath,
  windowsVolumeIdFromSerial,
  type Mount,
} from './volumes';

const serial = windowsVolumeIdFromSerial(0xa1b2c3d4n);

describe('joinVolume', () => {
  it('joins a windows drive and a posix mount', () => {
    expect(joinVolume('E:\\', 'dance/videos')).toBe('E:\\dance\\videos');
    expect(joinVolume('/media/usb', 'dance/videos')).toBe('/media/usb/dance/videos');
    expect(joinVolume('/media/usb', '')).toBe('/media/usb');
  });
});

describe('windows volume ids', () => {
  it('formats the volume serial the same way the CSV parser does', () => {
    expect(serial).toBe('vol:a1b2c3d4');
    const mounts = parseWindowsVolumeCsv(
      '"DeviceID","VolumeSerialNumber"\r\n"C:","A1B2-C3D4"\r\n"D:","00FF11AA"\r\n',
    );
    expect(mounts).toEqual([
      { volumeId: 'vol:a1b2c3d4', root: 'C:\\' },
      { volumeId: 'vol:00ff11aa', root: 'D:\\' },
    ]);
  });
});

describe('describeWindowsPath', () => {
  const mounts: Mount[] = [{ volumeId: serial, root: 'D:\\' }];

  it('stores a forward-slash path relative to the drive', () => {
    expect(describeWindowsPath('D:\\Dance\\Videos', mounts)).toEqual({
      volumeId: serial,
      root: 'D:\\',
      relPath: 'Dance/Videos',
    });
  });
});

describe('parseMountinfo', () => {
  it('unescapes mount points and keeps the device source', () => {
    const text = [
      '36 35 98:0 / /mnt/My\\040Disk rw,noatime - ext4 /dev/sdb1 rw',
      '37 1 0:21 / /proc rw - proc proc rw',
    ].join('\n');
    expect(parseMountinfo(text)).toEqual([
      { majorMinor: '98:0', mountPoint: '/mnt/My Disk', source: '/dev/sdb1', fsType: 'ext4' },
      { majorMinor: '0:21', mountPoint: '/proc', source: 'proc', fsType: 'proc' },
    ]);
  });
});

describe('describePosixPath', () => {
  const mounts: Mount[] = [
    { volumeId: 'uuid:root', root: '/' },
    { volumeId: 'uuid:usb', root: '/media/usb' },
    { volumeId: 'uuid:other', root: '/media/usb2' },
  ];

  it('uses the longest matching mount', () => {
    expect(describePosixPath('/media/usb/dance/a.mp4', mounts)).toEqual({
      volumeId: 'uuid:usb',
      root: '/media/usb',
      relPath: 'dance/a.mp4',
    });
  });
});

describe('parseDiskutilMounts', () => {
  it('reads mounted volumes and skips disks with no mount point', () => {
    const text = `
Device Node: /dev/disk2s1

   Volume UUID:               0E239BC6-F960-3107-88A0-B46D9D6E6E4E

   Mount Point:               /Volumes/Dance

Device Node: /dev/disk3
   Volume UUID:               Not applicable
   Mount Point:               Not applicable
`;
    expect(parseDiskutilMounts(text)).toEqual([
      { volumeId: 'uuid:0E239BC6-F960-3107-88A0-B46D9D6E6E4E', root: '/Volumes/Dance' },
    ]);
  });
});

describe('resolveLibraryPath', () => {
  const usb: Mount = { volumeId: serial, root: 'E:\\' };
  const impostor: Mount = { volumeId: 'vol:ffffffff', root: 'D:\\' };
  const library = { path: 'D:\\dance', volumeId: serial, volumeRelPath: 'dance' };

  function io(dirs: string[], descriptions: Record<string, { volumeId: string; relPath: string }>) {
    return {
      existsDir: (candidate: string) => dirs.includes(candidate),
      describe: (candidate: string) => {
        const described = descriptions[candidate];
        if (!described) return null;
        return { volumeId: described.volumeId, root: '', relPath: described.relPath };
      },
    };
  }

  it('follows a library onto a new windows drive letter', () => {
    const resolved = resolveLibraryPath(library, [usb], io(['E:\\dance'], {}));
    expect(resolved).toEqual({
      availability: 'online',
      path: 'E:\\dance',
      volumeId: serial,
      volumeRelPath: 'dance',
    });
  });

  it('stays offline when the volume is unplugged, even if another disk reused the letter', () => {
    const resolved = resolveLibraryPath(
      library,
      [impostor],
      io(['D:\\dance'], { 'D:\\dance': { volumeId: 'vol:ffffffff', relPath: 'dance' } }),
    );
    expect(resolved.availability).toBe('offline');
    expect(resolved.path).toBe('D:\\dance');
    expect(resolved.volumeId).toBe(serial);
  });

  it('prefers the original volume when it is mounted beside an impostor at the old path', () => {
    const resolved = resolveLibraryPath(
      library,
      [impostor, usb],
      io(['D:\\dance', 'E:\\dance'], {
        'D:\\dance': { volumeId: 'vol:ffffffff', relPath: 'dance' },
      }),
    );
    expect(resolved).toMatchObject({ availability: 'online', path: 'E:\\dance', volumeId: serial });
  });

  it('records the volume the first time a folder is scanned', () => {
    const resolved = resolveLibraryPath(
      { path: 'D:\\dance', volumeId: null, volumeRelPath: null },
      [usb],
      io(['D:\\dance'], { 'D:\\dance': { volumeId: serial, relPath: 'dance' } }),
    );
    expect(resolved).toEqual({
      availability: 'online',
      path: 'D:\\dance',
      volumeId: serial,
      volumeRelPath: 'dance',
    });
  });

  it('keeps the saved path when that path is still the same volume', () => {
    const resolved = resolveLibraryPath(
      library,
      [{ volumeId: serial, root: 'D:\\' }, usb],
      io(['D:\\dance', 'E:\\dance'], { 'D:\\dance': { volumeId: serial, relPath: 'dance' } }),
    );
    expect(resolved.path).toBe('D:\\dance');
    expect(resolved.availability).toBe('online');
  });
});

describe('listMounts', () => {
  it('describes a real directory on this machine', async () => {
    const mounts = await listMounts();
    expect(mounts.length).toBeGreaterThan(0);
    const described = describePath(path.resolve(os.tmpdir()), mounts);
    expect(described?.volumeId).toBeTruthy();
    expect(described?.relPath.length).toBeGreaterThan(0);
  });
});
