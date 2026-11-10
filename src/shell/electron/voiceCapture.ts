import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  VOICE_CAPTURE_ERROR_REASONS,
  VOICE_CAPTURE_MODES,
  type VoiceCaptureErrorReason,
  type VoiceCaptureEvent,
  type VoiceCaptureMode,
  type VoiceCaptureStartOptions,
} from '../../shared/voice.ts';

/**
 * SPEC-003 FR-10: dictation for a note's composer, ported from Cats Desktop
 * (`desktop/host/voiceCapture.ts` at cats-platform 6a2a1b02). One helper runs at
 * a time and speaks JSON lines: on macOS `native/macos-stt` (on-device speech
 * recognition), on Windows `native/windows-stt` (Windows speech recognition).
 * Other platforms have no helper yet. Speech becomes text; no audio is kept.
 */

export const NOTE_VOICE_START_CHANNEL = 'note:voiceStart';
export const NOTE_VOICE_STOP_CHANNEL = 'note:voiceStop';
export const NOTE_VOICE_CANCEL_CHANNEL = 'note:voiceCancel';
export const NOTE_VOICE_EVENT_CHANNEL = 'note:voiceEvent';

/** Where the shell runs from: a packaged app reads its helper from its resources. */
export interface VoiceCaptureHelperLocation {
  packaged: boolean;
  /** The app's directory (`app.getAppPath()`), where development builds stage their helper. */
  appPath: string;
  /** `process.resourcesPath` of a packaged app. */
  resourcesPath?: string;
}

const DEFAULT_READY_TIMEOUT_MS = 3_000;
const DEFAULT_CANCEL_CLEANUP_TIMEOUT_MS = 1_000;
const DEFAULT_STOP_CLEANUP_TIMEOUT_MS = 5_000;
const MAX_HELPER_STDERR_LINE_LENGTH = 500;

const VOICE_CAPTURE_MODE_SET = new Set<string>(VOICE_CAPTURE_MODES);
const VOICE_CAPTURE_ERROR_REASON_SET = new Set<string>(VOICE_CAPTURE_ERROR_REASONS);

type VoiceCaptureControlType = 'stop' | 'cancel';

interface ActiveVoiceCaptureSession {
  sessionId: string;
  child: ChildProcessWithoutNullStreams;
  ready: boolean;
  expectedExit: boolean;
  stdoutBuffer: string;
  stderrBuffer: string;
  readyTimer: ReturnType<typeof setTimeout> | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

type VoiceCaptureSpawn = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface DesktopVoiceCaptureControllerOptions {
  config: VoiceCaptureHelperLocation;
  sendEvent: (event: VoiceCaptureEvent) => void;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  resourcesPath?: string;
  spawnProcess?: VoiceCaptureSpawn;
  readyTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  stopCleanupTimeoutMs?: number;
  cancelCleanupTimeoutMs?: number;
  logLine?: (line: string) => void;
}

export function parseVoiceCaptureStartOptions(value: unknown): VoiceCaptureStartOptions {
  if (
    typeof value !== 'object'
    || value === null
    || typeof (value as { sessionId?: unknown }).sessionId !== 'string'
    || (value as { sessionId: string }).sessionId.trim().length === 0
  ) {
    throw new Error('Invalid voice capture start payload.');
  }

  const locale = (value as { locale?: unknown }).locale;
  if (locale !== undefined && (typeof locale !== 'string' || locale.trim().length === 0)) {
    throw new Error('Invalid voice capture locale.');
  }

  return {
    sessionId: (value as { sessionId: string }).sessionId.trim(),
    ...(typeof locale === 'string' ? { locale: locale.trim() } : {}),
  };
}

export function parseVoiceCaptureSessionId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Invalid voice capture session id.');
  }
  return value.trim();
}

function isVoiceCaptureMode(value: unknown): value is VoiceCaptureMode {
  return typeof value === 'string' && VOICE_CAPTURE_MODE_SET.has(value);
}

function isVoiceCaptureErrorReason(value: unknown): value is VoiceCaptureErrorReason {
  return typeof value === 'string' && VOICE_CAPTURE_ERROR_REASON_SET.has(value);
}

export function parseVoiceCaptureHelperEvent(line: string): VoiceCaptureEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const event = parsed as Record<string, unknown>;
  if (typeof event.sessionId !== 'string' || event.sessionId.trim().length === 0) {
    return null;
  }
  const sessionId = event.sessionId.trim();

  if (event.type === 'ready') {
    if (typeof event.locale !== 'string' || !isVoiceCaptureMode(event.mode)) {
      return null;
    }
    return {
      type: 'ready',
      sessionId,
      locale: event.locale,
      mode: event.mode,
    };
  }
  if (event.type === 'partial' || event.type === 'final') {
    if (typeof event.text !== 'string') {
      return null;
    }
    return {
      type: event.type,
      sessionId,
      text: event.text,
    };
  }
  if (event.type === 'error') {
    if (!isVoiceCaptureErrorReason(event.reason)) {
      return null;
    }
    return {
      type: 'error',
      sessionId,
      reason: event.reason,
    };
  }
  if (event.type === 'end') {
    return {
      type: 'end',
      sessionId,
    };
  }

  return null;
}

export function resolveVoiceCaptureHelperPath(input: {
  config: VoiceCaptureHelperLocation;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  resourcesPath?: string;
  arch?: string;
}): string | null {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const override = env.CATS_BOT_VOICE_HELPER?.trim();
  if (override) return override;
  const resources = input.resourcesPath ?? input.config.resourcesPath;
  if (platform === 'darwin') {
    return input.config.packaged && resources
      ? join(resources, 'native', 'macos-stt', 'cats-stt-macos')
      : join(input.config.appPath, 'build', 'native-macos', 'macos-stt', 'cats-stt-macos');
  }
  if (platform === 'win32') {
    return input.config.packaged && resources
      ? join(resources, 'native', 'windows-stt', 'cats-stt-windows.exe')
      : join(input.config.appPath, 'build', 'native-windows', input.arch ?? process.arch, 'windows-stt', 'cats-stt-windows.exe');
  }
  return null;
}

function buildVoiceCaptureHelperArgs(options: VoiceCaptureStartOptions): string[] {
  return [
    '--session-id',
    options.sessionId,
    ...(options.locale ? ['--locale', options.locale] : []),
  ];
}

function truncateHelperStderr(line: string): string {
  if (line.length <= MAX_HELPER_STDERR_LINE_LENGTH) {
    return line;
  }
  return `${line.slice(0, MAX_HELPER_STDERR_LINE_LENGTH)}...`;
}

function consumeLines(
  previousBuffer: string,
  chunk: Buffer,
  onLine: (line: string) => void,
): string {
  const parts = `${previousBuffer}${chunk.toString('utf8')}`.split(/\r?\n/u);
  const nextBuffer = parts.pop() ?? '';
  for (const line of parts) {
    if (line.trim()) {
      onLine(line);
    }
  }
  return nextBuffer;
}

function writeVoiceCaptureControl(
  session: ActiveVoiceCaptureSession,
  type: VoiceCaptureControlType,
): void {
  session.child.stdin.write(`${JSON.stringify({ type, sessionId: session.sessionId })}\n`);
}

export class DesktopVoiceCaptureController {
  private activeSession: ActiveVoiceCaptureSession | null = null;

  private readonly config: VoiceCaptureHelperLocation;
  private readonly sendEvent: (event: VoiceCaptureEvent) => void;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly resourcesPath?: string;
  private readonly spawnProcess: VoiceCaptureSpawn;
  private readonly readyTimeoutMs: number;
  private readonly stopCleanupTimeoutMs: number;
  private readonly cancelCleanupTimeoutMs: number;
  private readonly logLine: (line: string) => void;

  constructor(options: DesktopVoiceCaptureControllerOptions) {
    this.config = options.config;
    this.sendEvent = options.sendEvent;
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.resourcesPath = options.resourcesPath;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.stopCleanupTimeoutMs = options.stopCleanupTimeoutMs
      ?? options.cleanupTimeoutMs
      ?? DEFAULT_STOP_CLEANUP_TIMEOUT_MS;
    this.cancelCleanupTimeoutMs = options.cancelCleanupTimeoutMs
      ?? options.cleanupTimeoutMs
      ?? DEFAULT_CANCEL_CLEANUP_TIMEOUT_MS;
    this.logLine = options.logLine ?? ((line) => {
      process.stderr.write(`${line}\n`);
    });
  }

  async startVoiceCapture(options: VoiceCaptureStartOptions): Promise<void> {
    // Cats Bot has several notes: the previous session (perhaps another note's) ends now, with its `end`,
    // rather than after its helper exits, which the controller would no longer see.
    const previous = this.activeSession;
    if (previous) {
      try {
        writeVoiceCaptureControl(previous, 'cancel');
      } catch {
        // A helper that cannot take the request is killed below.
      }
      this.finishSession(previous, { emitEnd: true, kill: true });
    }

    const helperPath = resolveVoiceCaptureHelperPath({
      config: this.config,
      platform: this.platform,
      env: this.env,
      resourcesPath: this.resourcesPath,
    });
    if (!helperPath || !existsSync(helperPath)) {
      this.emitErrorAndEnd(options.sessionId, 'engine_unavailable');
      return;
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess(
        helperPath,
        buildVoiceCaptureHelperArgs(options),
        {
          cwd: dirname(helperPath),
          env: this.env,
          shell: false,
        },
      );
    } catch {
      this.emitErrorAndEnd(options.sessionId, 'engine_unavailable');
      return;
    }

    const session: ActiveVoiceCaptureSession = {
      sessionId: options.sessionId,
      child,
      ready: false,
      expectedExit: false,
      stdoutBuffer: '',
      stderrBuffer: '',
      readyTimer: null,
      cleanupTimer: null,
    };
    this.activeSession = session;

    session.readyTimer = setTimeout(() => {
      if (this.activeSession !== session || session.ready) {
        return;
      }
      this.sendEvent({
        type: 'error',
        sessionId: session.sessionId,
        reason: 'engine_unavailable',
      });
      this.finishSession(session, { emitEnd: true, kill: true });
    }, this.readyTimeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      session.stdoutBuffer = consumeLines(session.stdoutBuffer, chunk, (line) => {
        this.handleHelperEventLine(session, line);
      });
    });
    child.stderr.on('data', (chunk: Buffer) => {
      session.stderrBuffer = consumeLines(session.stderrBuffer, chunk, (line) => {
        this.logLine(`[voice-capture] ${truncateHelperStderr(line)}`);
      });
    });
    child.once('error', () => {
      if (this.activeSession !== session) {
        return;
      }
      this.sendEvent({
        type: 'error',
        sessionId: session.sessionId,
        reason: 'engine_unavailable',
      });
      this.finishSession(session, { emitEnd: true, kill: true });
    });
    child.once('close', () => {
      if (this.activeSession !== session) {
        return;
      }
      if (session.expectedExit) {
        this.finishSession(session, { emitEnd: true, kill: false });
        return;
      }
      this.sendEvent({
        type: 'error',
        sessionId: session.sessionId,
        reason: 'helper_crashed',
      });
      this.finishSession(session, { emitEnd: true, kill: false });
    });
  }

  async stopVoiceCapture(sessionId: string): Promise<void> {
    this.requestSessionEnd(sessionId, 'stop');
  }

  async cancelVoiceCapture(sessionId: string): Promise<void> {
    this.requestSessionEnd(sessionId, 'cancel');
  }

  dispose(): void {
    if (this.activeSession) {
      this.finishSession(this.activeSession, { emitEnd: false, kill: true });
    }
  }

  private handleHelperEventLine(session: ActiveVoiceCaptureSession, line: string): void {
    if (this.activeSession !== session) {
      return;
    }
    const event = parseVoiceCaptureHelperEvent(line);
    if (!event || event.sessionId !== session.sessionId) {
      return;
    }

    if (event.type === 'ready') {
      session.ready = true;
      if (session.readyTimer) {
        clearTimeout(session.readyTimer);
        session.readyTimer = null;
      }
      this.sendEvent(event);
      return;
    }
    if (event.type === 'error') {
      this.sendEvent(event);
      this.finishSession(session, { emitEnd: true, kill: true });
      return;
    }
    if (event.type === 'end') {
      this.finishSession(session, { emitEnd: true, kill: false });
      return;
    }

    this.sendEvent(event);
  }

  private requestSessionEnd(sessionId: string, type: VoiceCaptureControlType): void {
    const session = this.activeSession;
    if (!session || session.sessionId !== sessionId) {
      return;
    }
    session.expectedExit = true;
    try {
      writeVoiceCaptureControl(session, type);
    } catch {
      this.finishSession(session, { emitEnd: true, kill: true });
      return;
    }

    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
    }
    const cleanupTimeoutMs = type === 'stop'
      ? this.stopCleanupTimeoutMs
      : this.cancelCleanupTimeoutMs;
    session.cleanupTimer = setTimeout(() => {
      if (this.activeSession !== session) {
        return;
      }
      this.finishSession(session, { emitEnd: true, kill: true });
    }, cleanupTimeoutMs);
  }

  private emitErrorAndEnd(sessionId: string, reason: VoiceCaptureErrorReason): void {
    this.sendEvent({ type: 'error', sessionId, reason });
    this.sendEvent({ type: 'end', sessionId });
  }

  private finishSession(
    session: ActiveVoiceCaptureSession,
    options: { emitEnd: boolean; kill: boolean },
  ): void {
    if (this.activeSession !== session) {
      return;
    }
    this.activeSession = null;
    if (session.readyTimer) {
      clearTimeout(session.readyTimer);
      session.readyTimer = null;
    }
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = null;
    }
    if (options.kill && !session.child.killed) {
      session.child.kill();
    }
    if (options.emitEnd) {
      this.sendEvent({ type: 'end', sessionId: session.sessionId });
    }
  }
}
