import { join } from 'node:path';
import { createLogWriter } from '../shared/diagnosticLog.ts';

/**
 * SPEC-001 NFR security: the log records what happened (kinds, states,
 * reasons, counts), never prompts, replies or credentials. Callers pass only
 * such lines.
 */
export type Logger = (line: string) => void;

export function createFileLogger(logsDir: string, mirror?: Logger): Logger {
  const write = createLogWriter(join(logsDir, 'core.log'));
  return (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    write(`${stamped}\n`);
    try { mirror?.(stamped); } catch { /* a closed stderr must not stop the core */ }
  };
}
