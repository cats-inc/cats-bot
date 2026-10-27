import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SPEC-001 NFR security: the log records what happened (kinds, states,
 * reasons, counts), never prompts, replies or credentials. Callers pass only
 * such lines.
 */
export type Logger = (line: string) => void;

export function createFileLogger(logsDir: string, mirror?: Logger): Logger {
  let ready = false;
  return (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    try {
      if (!ready) {
        mkdirSync(logsDir, { recursive: true });
        ready = true;
      }
      appendFileSync(join(logsDir, 'core.log'), `${stamped}\n`, { encoding: 'utf8' });
    } catch {
      // Logging must never take the bot down.
    }
    mirror?.(stamped);
  };
}
