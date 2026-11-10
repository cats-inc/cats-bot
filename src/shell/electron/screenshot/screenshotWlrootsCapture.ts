import { spawn } from 'node:child_process';

import type {
  DesktopScreenshotCaptureResult,
} from '../../../shared/screenshot/contracts.ts';
import {
  isPhysicalCropRectLargeEnough,
  type DesktopScreenshotPhysicalRect,
} from '../../../shared/screenshot/screenshotGeometry.ts';

const WLROOTS_SESSION_MARKERS = [
  'wlroots',
  'labwc',
  'sway',
  'wayfire',
  'river',
  'hyprland',
];
const WLROOTS_TOOL_PROBE_TIMEOUT_MS = 3_000;
const WLROOTS_TOOL_PROBE_MAX_BUFFER_BYTES = 256 * 1024;
const WLROOTS_CAPTURE_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const WLROOTS_UNSUPPORTED_MESSAGE =
  'Native wlroots screenshot capture requires grim and slurp.';

export interface WlrootsScreenshotCommandOptions {
  timeoutMs?: number;
  maxBufferBytes?: number;
  stdin?: string;
}

export interface WlrootsScreenshotCommandResult {
  stdout: Uint8Array;
  stderr: string;
}

export type WlrootsScreenshotCommandRunner = (
  command: string,
  args: string[],
  options?: WlrootsScreenshotCommandOptions,
) => Promise<WlrootsScreenshotCommandResult>;

export interface WlrootsScreenshotSessionInput {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

export interface CaptureWlrootsScreenshotRegionOptions extends WlrootsScreenshotSessionInput {
  runCommand?: WlrootsScreenshotCommandRunner;
  workAreas?: DesktopScreenshotPhysicalRect[];
  createFilename: () => string;
}

interface WlrootsScreenshotCommandFailure extends Error {
  code?: string | number | null;
  signal?: NodeJS.Signals | null;
  stdout?: Uint8Array;
  stderr?: string;
}

export function isLikelyWlrootsScreenshotSession(
  input: WlrootsScreenshotSessionInput,
): boolean {
  if (
    input.platform !== 'linux'
    || input.env.XDG_SESSION_TYPE?.toLowerCase() !== 'wayland'
  ) {
    return false;
  }

  const desktopMarkers = [
    input.env.XDG_CURRENT_DESKTOP,
    input.env.DESKTOP_SESSION,
    input.env.WAYLAND_DISPLAY,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(':')
    .toLowerCase();

  return WLROOTS_SESSION_MARKERS.some((marker) => desktopMarkers.includes(marker));
}

export function createNodeWlrootsScreenshotCommandRunner(): WlrootsScreenshotCommandRunner {
  return async (command, args, options = {}) => await new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const maxBufferBytes = options.maxBufferBytes ?? WLROOTS_CAPTURE_MAX_BUFFER_BYTES;
    let stdoutBytes = 0;
    let settled = false;
    let timedOut = false;
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, options.timeoutMs)
      : null;

    function settleWithError(error: WlrootsScreenshotCommandFailure): void {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      reject(error);
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxBufferBytes) {
        const error = new Error(
          `${command} produced more than ${maxBufferBytes} bytes of output.`,
        ) as WlrootsScreenshotCommandFailure;
        error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        settleWithError(error);
        child.kill('SIGTERM');
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.stdin?.on('error', () => {
      // Child process failures are reported through error/close handlers.
    });
    child.stdin?.end(options.stdin ?? '');
    child.on('error', (error: NodeJS.ErrnoException) => {
      const wrapped = new Error(error.message) as WlrootsScreenshotCommandFailure;
      wrapped.code = error.code;
      settleWithError(wrapped);
    });
    child.on('close', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }

      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (timedOut) {
        const error = new Error(`${command} timed out.`) as WlrootsScreenshotCommandFailure;
        error.code = 'ETIMEDOUT';
        error.signal = signal;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error = new Error(
        stderr.trim() || `${command} exited with code ${String(code)}.`,
      ) as WlrootsScreenshotCommandFailure;
      error.code = code;
      error.signal = signal;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

export async function captureWlrootsNativeScreenshotRegion(
  options: CaptureWlrootsScreenshotRegionOptions,
): Promise<DesktopScreenshotCaptureResult> {
  if (!isLikelyWlrootsScreenshotSession(options)) {
    return {
      outcome: 'platform_unsupported',
      message: 'Native wlroots screenshot capture is not available in this session.',
    };
  }

  const runCommand = options.runCommand ?? createNodeWlrootsScreenshotCommandRunner();
  if (!await hasWlrootsScreenshotTools(runCommand)) {
    return {
      outcome: 'platform_unsupported',
      message: WLROOTS_UNSUPPORTED_MESSAGE,
    };
  }

  const selection = await selectWlrootsScreenshotRegion(runCommand, options.workAreas);
  if (selection.outcome !== 'ok') {
    return selection;
  }

  if (!isPhysicalCropRectLargeEnough(selection.rect)) {
    return {
      outcome: 'cancelled',
      reason: 'too_small',
    };
  }

  try {
    const png = await runCommand(
      'grim',
      ['-g', formatWlrootsScreenshotGeometry(selection.rect), '-t', 'png', '-'],
      { maxBufferBytes: WLROOTS_CAPTURE_MAX_BUFFER_BYTES },
    );
    const size = readPngSize(png.stdout) ?? {
      width: selection.rect.width,
      height: selection.rect.height,
    };

    return {
      outcome: 'ok',
      png: png.stdout,
      mime: 'image/png',
      filename: options.createFilename(),
      width: size.width,
      height: size.height,
    };
  } catch (error) {
    if (isMissingCommandError(error)) {
      return {
        outcome: 'platform_unsupported',
        message: WLROOTS_UNSUPPORTED_MESSAGE,
      };
    }
    return {
      outcome: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function hasWlrootsScreenshotTools(
  runCommand: WlrootsScreenshotCommandRunner,
): Promise<boolean> {
  const [grim, slurp] = await Promise.all([
    hasWlrootsScreenshotTool(runCommand, 'grim'),
    hasWlrootsScreenshotTool(runCommand, 'slurp'),
  ]);
  return grim && slurp;
}

async function hasWlrootsScreenshotTool(
  runCommand: WlrootsScreenshotCommandRunner,
  command: 'grim' | 'slurp',
): Promise<boolean> {
  try {
    await runCommand(command, ['-h'], {
      timeoutMs: WLROOTS_TOOL_PROBE_TIMEOUT_MS,
      maxBufferBytes: WLROOTS_TOOL_PROBE_MAX_BUFFER_BYTES,
    });
    return true;
  } catch {
    return false;
  }
}

async function selectWlrootsScreenshotRegion(
  runCommand: WlrootsScreenshotCommandRunner,
  workAreas: DesktopScreenshotPhysicalRect[] | undefined,
): Promise<
  | { outcome: 'ok'; rect: DesktopScreenshotPhysicalRect }
  | Exclude<DesktopScreenshotCaptureResult, { outcome: 'ok' }>
> {
  try {
    const workAreaInput = formatWlrootsScreenshotWorkAreaInput(workAreas);
    const selection = await runCommand('slurp', [
      '-f',
      '%x,%y %wx%h',
      '-b',
      '#00000055',
      '-c',
      '#f8fafcff',
      '-s',
      '#ffffff22',
      '-w',
      '1',
      ...(workAreaInput ? ['-r'] : []),
    ], workAreaInput ? { stdin: workAreaInput } : undefined);
    const rect = parseWlrootsScreenshotGeometry(
      Buffer.from(selection.stdout).toString('utf8'),
    );
    if (!rect) {
      return {
        outcome: 'error',
        message: 'Could not parse wlroots screenshot selection geometry.',
      };
    }
    return {
      outcome: 'ok',
      rect,
    };
  } catch (error) {
    if (isMissingCommandError(error)) {
      return {
        outcome: 'platform_unsupported',
        message: WLROOTS_UNSUPPORTED_MESSAGE,
      };
    }
    return {
      outcome: 'cancelled',
      reason: 'user_cancel',
    };
  }
}

export function parseWlrootsScreenshotGeometry(
  rawGeometry: string,
): DesktopScreenshotPhysicalRect | null {
  const match = rawGeometry.trim().match(/^(-?\d+),(-?\d+)\s+(\d+)x(\d+)$/u);
  if (!match) {
    return null;
  }

  return {
    x: Number.parseInt(match[1]!, 10),
    y: Number.parseInt(match[2]!, 10),
    width: Number.parseInt(match[3]!, 10),
    height: Number.parseInt(match[4]!, 10),
  };
}

export function formatWlrootsScreenshotGeometry(
  rect: Pick<DesktopScreenshotPhysicalRect, 'x' | 'y' | 'width' | 'height'>,
): string {
  return `${rect.x},${rect.y} ${rect.width}x${rect.height}`;
}

export function formatWlrootsScreenshotWorkAreaInput(
  workAreas: DesktopScreenshotPhysicalRect[] | undefined,
): string | null {
  const lines = (workAreas ?? [])
    .filter((workArea) => workArea.width > 0 && workArea.height > 0)
    .map((workArea) => formatWlrootsScreenshotGeometry(workArea));
  return lines.length > 0 ? `${lines.join('\n')}\n` : null;
}

function isMissingCommandError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === 'ENOENT';
}

function readPngSize(png: Uint8Array): { width: number; height: number } | null {
  if (
    png.byteLength < 24
    || png[0] !== 0x89
    || png[1] !== 0x50
    || png[2] !== 0x4e
    || png[3] !== 0x47
    || png[4] !== 0x0d
    || png[5] !== 0x0a
    || png[6] !== 0x1a
    || png[7] !== 0x0a
  ) {
    return null;
  }

  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0
    ? { width, height }
    : null;
}
