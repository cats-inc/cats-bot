import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';

/** Per-user gates cannot see another account using /Applications or /opt. */
export function assertNoOtherUsers(executable: string, platform = process.platform, uid = process.getuid?.(), readProcesses?: () => string): void {
  if (platform !== 'darwin' && platform !== 'linux') return;
  if (uid === undefined) throw new Error('Cannot verify other users of this installation. Use the release page to update manually.');
  const installPath = platform === 'darwin' ? executable.slice(0, executable.lastIndexOf('.app/') + 4) : dirname(executable);
  if (!installPath.startsWith('/') || installPath.length < 5) throw new Error('Cannot identify the shared installation.');
  const output = readProcesses ? readProcesses() : execFileSync('/bin/ps', ['-axo', 'pid=,uid=,command='], { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
  if (!output.trim()) throw new Error('Cannot verify other users of this installation.');
  for (const line of output.split('\n').filter(line => line.trim())) {
    const match = /^\s*\d+\s+(\d+)\s+(.+)$/u.exec(line);
    if (!match) throw new Error('Cannot read the system process list.');
    if (Number(match[1]) !== uid && match[2]!.includes(installPath + '/')) {
      throw new Error('Another signed-in user is running Cats Bot from this installation. Ask them to quit before installing the update.');
    }
  }
}
