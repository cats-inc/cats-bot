import { spawn, type ChildProcess } from 'node:child_process';
import { Socket } from 'node:net';

/**
 * Adapted from cats-platform desktop/host/linuxRelaunch.ts at 87aa62cb (MIT).
 *
 * Electron 41's native relaunch helper adds NoNewPrivs before launching the
 * replacement, which then cannot use pkexec for its next .deb update. A Node
 * child inherits the existing restriction unchanged, including NoNewPrivs=1.
 * Stdin stays open until this host's exit releases it, after Electron has
 * released its single-instance lock: EOF is the barrier, not a guessed delay.
 */
const RELAUNCH_HELPER = `
const { spawn } = require('node:child_process');
const [executable, args] = JSON.parse(process.argv[1]);
delete process.env.ELECTRON_RUN_AS_NODE;
process.stdin.resume();
process.stdin.once('end', () => {
  const child = spawn(executable, args, { detached: true, stdio: 'ignore' });
  child.once('error', (error) => {
    console.error('[bot-relaunch] replacement launch failed:', error.message);
    process.exitCode = 1;
  });
  child.unref();
});
`;

export interface LinuxRelaunchOptions {
  executable: string;
  logger: (message: string) => void;
}

/** Schedules one replacement after this host exits, without adding privilege restrictions. */
export function createLinuxRelaunch(options: LinuxRelaunchOptions): (args: string[]) => void {
  let pendingHelper: ChildProcess | null = null;
  return (args) => {
    if (pendingHelper) return;
    let helper: ChildProcess;
    try {
      // No cwd option: the child inherits it either way, and process.cwd() throws once that directory is gone.
      helper = spawn(options.executable, ['-e', RELAUNCH_HELPER, '--', JSON.stringify([options.executable, args])], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        detached: true,
        stdio: ['pipe', 'ignore', 'inherit'],
      });
    } catch (error) {
      // Callers quit next: a replacement that cannot start must not keep a drained host alive.
      options.logger(`[bot-relaunch] helper launch failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    pendingHelper = helper;
    helper.once('error', (error) => {
      pendingHelper = null;
      options.logger(`[bot-relaunch] helper launch failed: ${error.message}`);
    });
    helper.once('exit', (code, signal) => {
      pendingHelper = null;
      if (code !== 0) options.logger(`[bot-relaunch] helper exited: code=${code}, signal=${signal}`);
    });
    // Do not end or destroy stdin: only this host's termination may release the child.
    if (helper.stdin instanceof Socket) helper.stdin.unref();
    helper.unref();
  };
}
