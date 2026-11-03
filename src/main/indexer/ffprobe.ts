import { resolveBundledTool, ensureExecutable } from '../binaries';
import { parseMediaTimestamp } from './captureDate';
import { clipError, runProcess } from './process';

const PROBE_TIMEOUT_MS = 30_000;

export type ProbeResult = {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  metadataCreatedAt: string | null;
  error: string | null;
};

type FfprobeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string | number;
  tags?: Record<string, string>;
  side_data_list?: { rotation?: number | string }[];
  disposition?: { attached_pic?: number };
};

type FfprobeJson = {
  streams?: FfprobeStream[];
  format?: {
    duration?: string | number;
    tags?: Record<string, string>;
  };
};

export function ffprobeArgs(filePath: string): string[] {
  return ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath];
}

export function parseFfprobeJson(payload: unknown): ProbeResult {
  const json = isRecord(payload) ? (payload as FfprobeJson) : {};
  const streams = Array.isArray(json.streams) ? json.streams : [];
  const stream = chooseVideoStream(streams);
  if (!stream) {
    return {
      durationMs: null,
      width: null,
      height: null,
      videoCodec: null,
      metadataCreatedAt: readTimestamp(json.format?.tags, streams),
      error: 'No video stream',
    };
  }
  const size = displaySize(stream);
  return {
    durationMs: durationMs(json.format?.duration, stream.duration),
    width: size.width,
    height: size.height,
    videoCodec: stream.codec_name ?? null,
    metadataCreatedAt: readTimestamp(json.format?.tags, [stream, ...streams]),
    error: null,
  };
}

export async function probeVideo(filePath: string): Promise<ProbeResult> {
  let binary: string;
  try {
    binary = resolveBundledTool('ffprobe');
    ensureExecutable(binary);
  } catch (error) {
    return emptyProbe(error instanceof Error ? error.message : String(error));
  }
  const result = await runProcess(binary, ffprobeArgs(filePath), PROBE_TIMEOUT_MS);
  if (result.timedOut) return emptyProbe('ffprobe timed out');
  if (result.code !== 0) {
    return emptyProbe(
      clipError(result.stderr || result.stdout || `ffprobe exited with code ${result.code}`),
    );
  }
  try {
    return parseFfprobeJson(JSON.parse(result.stdout) as unknown);
  } catch (error) {
    return emptyProbe(error instanceof Error ? error.message : 'ffprobe returned invalid JSON');
  }
}

function chooseVideoStream(streams: readonly FfprobeStream[]): FfprobeStream | null {
  const videos = streams.filter((stream) => stream.codec_type === 'video');
  const real = videos.find(
    (stream) =>
      stream.disposition?.attached_pic !== 1 &&
      stream.codec_name !== 'mjpeg' &&
      stream.codec_name !== 'png',
  );
  return real ?? videos[0] ?? null;
}

function displaySize(stream: FfprobeStream): { width: number | null; height: number | null } {
  const width = finite(stream.width);
  const height = finite(stream.height);
  const rotation = rotationDegrees(stream);
  if (width != null && height != null && (rotation === 90 || rotation === 270)) {
    return { width: height, height: width };
  }
  return { width, height };
}

function rotationDegrees(stream: FfprobeStream): number {
  const tag = stream.tags?.rotate;
  const fromTag = tag == null ? null : normalizeDegrees(Number(tag));
  if (fromTag != null) return fromTag;
  for (const side of stream.side_data_list ?? []) {
    const rotation = normalizeDegrees(Number(side.rotation));
    if (rotation != null) return rotation;
  }
  return 0;
}

function normalizeDegrees(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return ((Math.round(value) % 360) + 360) % 360;
}

function durationMs(
  formatDuration: string | number | undefined,
  streamDuration: string | number | undefined,
): number | null {
  const seconds = secondsOf(formatDuration) ?? secondsOf(streamDuration);
  if (seconds == null) return null;
  return Math.round(seconds * 1000);
}

function secondsOf(value: string | number | undefined): number | null {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function readTimestamp(
  formatTags: Record<string, string> | undefined,
  streams: readonly FfprobeStream[],
): string | null {
  const bags = [formatTags, ...streams.map((stream) => stream.tags)];
  for (const tags of bags) {
    if (!tags) continue;
    for (const key of ['creation_time', 'com.apple.quicktime.creationdate', 'date']) {
      const value = tags[key];
      if (!value) continue;
      const parsed = parseMediaTimestamp(value);
      if (parsed) return parsed;
    }
  }
  return null;
}

function finite(value: number | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}

function emptyProbe(error: string): ProbeResult {
  return {
    durationMs: null,
    width: null,
    height: null,
    videoCodec: null,
    metadataCreatedAt: null,
    error,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
