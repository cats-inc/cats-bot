import { basename, join } from 'node:path';
import type { App, BrowserWindow, Screen } from 'electron';
import {
  boundedText,
  createLogWriter,
  diagnosticError,
  LOG_ENTRY_BYTES,
} from '../../shared/diagnosticLog.ts';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
const ranks: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
export function logLevel(value?: string): LogLevel {
  return value && Object.hasOwn(ranks, value) ? (value as LogLevel) : 'info';
}

/** Defence in depth for existing diagnostic strings; new events use only allowlisted metadata. */
export function redactLogText(text: string): string {
  return text
    .replace(/\bBearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      '$1[redacted]',
    )
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|\d{6,}:[A-Za-z0-9_-]{20,})\b/gu, '[redacted]')
    .replace(/\b(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, '$1[redacted]@')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, '');
}

export function createHostLogger(
  userData: string,
  options: { level?: string; mirror?: (line: string) => void } = {},
) {
  const level = logLevel(options.level);
  const file = join(userData, 'logs', 'host.log');
  const write = createLogWriter(file);
  const started = performance.now();
  const record = (
    event: string,
    fields: Record<string, unknown> = {},
    severity: LogLevel = 'info',
  ) => {
    if (ranks[severity] < ranks[level]) return;
    try {
      const data = JSON.stringify(fields, (_key, value: unknown) =>
        typeof value === 'string' ? redactLogText(value) : value,
      );
      const line = boundedText(
        `${new Date().toISOString()} ${severity.toUpperCase()} pid=${process.pid} +${Math.round(performance.now() - started)}ms ${event} ${data}\n`,
        LOG_ENTRY_BYTES,
      );
      write(line);
      try {
        options.mirror?.(line);
      } catch {
        /* closed or absent console */
      }
    } catch {
      /* diagnostic metadata must never interrupt the host */
    }
  };
  return {
    file,
    level,
    record,
    log: (line: string, severity: LogLevel = 'info') => record('host', { message: line }, severity),
    error: (event: string, error: unknown) =>
      record(event, { error: diagnosticError(error) }, 'error'),
  };
}
export type HostLogger = ReturnType<typeof createHostLogger>;

/** Monitoring leaves Node's fatal-exception behaviour intact; it never starts Crashpad. */
export function observeHostProcess(logger: HostLogger, target = process): () => void {
  const fatal = (error: Error, origin: string) =>
    logger.record('fatal', { origin, error: diagnosticError(error) }, 'error');
  const warning = (error: Error) =>
    logger.record('warning', { error: diagnosticError(error) }, 'warn');
  const exit = (code: number) =>
    logger.record('process-exit', { code }, code === 0 ? 'info' : 'error');
  target.on('uncaughtExceptionMonitor', fatal);
  target.on('warning', warning);
  target.on('exit', exit);
  return () => {
    target.off('uncaughtExceptionMonitor', fatal);
    target.off('warning', warning);
    target.off('exit', exit);
  };
}

function pageKind(window: BrowserWindow): string {
  try {
    const page = basename(new URL(window.webContents.getURL()).pathname);
    return ['note.html', 'floating.html', 'settings.html'].includes(page)
      ? page.slice(0, -5)
      : 'other';
  } catch {
    return 'loading';
  }
}

function windowState(window: BrowserWindow): Record<string, unknown> {
  try {
    if (window.isDestroyed()) return { windowId: window.id, destroyed: true };
    return {
      windowId: window.id,
      page: pageKind(window),
      bounds: window.getBounds(),
      visible: window.isVisible(),
      minimized: window.isMinimized(),
    };
  } catch {
    return { windowId: window.id, unavailable: true };
  }
}

export function observeHostApp(app: App, windows: () => BrowserWindow[], logger: HostLogger): void {
  app.on('second-instance', () => logger.record('second-instance-handoff'));
  app.on('browser-window-created', (_event, window) => {
    const events: NodeJS.EventEmitter = window;
    logger.record('window-created', windowState(window));
    for (const event of [
      'show',
      'hide',
      'minimize',
      'restore',
      'unresponsive',
      'responsive',
    ] as const) {
      events.on(event, () =>
        logger.record(
          `window-${event}`,
          windowState(window),
          event === 'unresponsive' ? 'warn' : 'info',
        ),
      );
    }
    window.on('closed', () => logger.record('window-closed', { windowId: window.id }));
    // Position/size changes during dragging are intentionally opt-in.
    for (const event of ['move', 'resize'] as const) {
      events.on(event, () => {
        if (ranks[logger.level] <= ranks.debug)
          logger.record(`window-${event}`, windowState(window), 'debug');
      });
    }
    window.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (mainFrame) logger.record('page-load-failed', { ...windowState(window), code }, 'error');
    });
  });
  app.on('render-process-gone', (_event, contents, details) => {
    const window = windows().find(
      (candidate) => !candidate.isDestroyed() && candidate.webContents.id === contents.id,
    );
    logger.record(
      'renderer-gone',
      {
        ...(window ? windowState(window) : {}),
        webContentsId: contents.id,
        reason: details.reason,
        exitCode: details.exitCode,
      },
      details.reason === 'clean-exit' ? 'info' : 'error',
    );
  });
  app.on('child-process-gone', (_event, details) =>
    logger.record(
      'child-process-gone',
      {
        type: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
      },
      details.reason === 'clean-exit' ? 'info' : 'error',
    ),
  );
  for (const event of ['before-quit', 'will-quit', 'window-all-closed'] as const) {
    const events: NodeJS.EventEmitter = app;
    events.on(event, () => logger.record(event, { windows: windows().map(windowState) }));
  }
  app.on('quit', (_event, code) => logger.record('quit', { code }));
}

export function observeDisplays(
  screen: Screen,
  windows: () => BrowserWindow[],
  logger: HostLogger,
): void {
  const snapshot = (event: string, changed?: number, metrics?: string[]) => {
    try {
      logger.record(event, {
        changedDisplayId: changed,
        metrics,
        displays: screen
          .getAllDisplays()
          .map((display) => ({
            id: display.id,
            primary: display.id === screen.getPrimaryDisplay().id,
            bounds: display.bounds,
            workArea: display.workArea,
            scaleFactor: display.scaleFactor,
            rotation: display.rotation,
          })),
        windows: windows().map(windowState),
      });
    } catch (error) {
      logger.error('displays-unavailable', error);
    }
  };
  snapshot('displays-ready');
  screen.on('display-added', (_event, display) => snapshot('display-added', display.id));
  screen.on('display-removed', (_event, display) => snapshot('display-removed', display.id));
  screen.on('display-metrics-changed', (_event, display, metrics) =>
    snapshot('display-metrics-changed', display.id, metrics),
  );
}
