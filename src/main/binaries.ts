import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import ffmpegStatic from 'ffmpeg-static';

export type ToolName = 'ffmpeg' | 'ffprobe';

export type ToolProbe =
  { ok: true; version: string } | { ok: false; version: string | null; error: string };

const VERSION_TIMEOUT_MS = 15_000;

/** Packaged binaries live in app.asar.unpacked so the OS can execute them. */
export function unpackAsarPath(binaryPath: string): string {
  return binaryPath.replace(/app\.asar(?!\.unpacked)/g, 'app.asar.unpacked');
}

export function binaryPathFromModule(mod: unknown, label: string): string {
  const raw = unwrapBinaryPath(mod);
  if (!raw) throw new Error(`Bundled ${label} binary is missing`);
  return unpackAsarPath(raw);
}

export function resolveBundledTool(tool: ToolName): string {
  return binaryPathFromModule(tool === 'ffmpeg' ? ffmpegStatic : ffprobeInstaller, tool);
}

export function parseToolVersion(output: string, tool: ToolName): string | null {
  const match = new RegExp(`${tool} version\\s+(\\S+)`, 'i').exec(output);
  return match?.[1] ?? null;
}

export function ensureExecutable(binaryPath: string): void {
  if (process.platform === 'win32') return;
  const stat = fs.statSync(binaryPath);
  if (!stat.isFile()) throw new Error(`Bundled binary is not a file: ${binaryPath}`);
  if ((stat.mode & 0o111) === 0) fs.chmodSync(binaryPath, stat.mode | 0o755);
  if (process.platform === 'darwin') {
    // npm marks downloaded binaries as quarantined. Clearing that lets an
    // unsigned ffprobe start instead of waiting on Gatekeeper.
    spawnSync('xattr', ['-d', 'com.apple.quarantine', binaryPath], { stdio: 'ignore' });
  }
}

export function readToolVersion(binaryPath: string, tool: ToolName): Promise<ToolProbe> {
  return new Promise((resolve) => {
    let settled = false;
    const state: { timer?: ReturnType<typeof setTimeout>; child?: ChildProcess } = {};

    const finish = (result: ToolProbe) => {
      if (settled) return;
      settled = true;
      if (state.timer) clearTimeout(state.timer);
      resolve(result);
    };

    try {
      ensureExecutable(binaryPath);
      state.child = spawn(binaryPath, ['-version'], { windowsHide: true });
    } catch (error) {
      finish({ ok: false, version: null, error: errorMessage(error) });
      return;
    }

    const child = state.child;
    if (!child) {
      finish({ ok: false, version: null, error: `${tool} failed to start` });
      return;
    }
    state.timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, version: null, error: `${tool} timed out` });
    }, VERSION_TIMEOUT_MS);

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      finish({ ok: false, version: null, error: error.message });
    });
    child.on('close', (code) => {
      const version = parseToolVersion(stdout, tool) ?? parseToolVersion(stderr, tool);
      if (code === 0 && version) {
        finish({ ok: true, version });
        return;
      }
      const detail = stderr.trim() || stdout.trim() || `${tool} exited with code ${code ?? 'null'}`;
      finish({ ok: false, version, error: detail });
    });
  });
}

export async function probeBundledFfprobe(): Promise<ToolProbe> {
  try {
    return await readToolVersion(resolveBundledTool('ffprobe'), 'ffprobe');
  } catch (error) {
    return { ok: false, version: null, error: errorMessage(error) };
  }
}

function unwrapBinaryPath(mod: unknown, depth = 0): string | null {
  if (typeof mod === 'string' && mod.length > 0) return mod;
  if (!mod || typeof mod !== 'object' || depth > 2) return null;
  if ('path' in mod && typeof mod.path === 'string' && mod.path.length > 0) return mod.path;
  if ('default' in mod) return unwrapBinaryPath(mod.default, depth + 1);
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
