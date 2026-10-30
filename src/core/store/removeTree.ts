import { chmodSync, lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Removes a directory tree without ever entering a junction or symbolic link:
 * a link is removed as a link, and what it points to is kept. Node's
 * recursive `rmSync` follows junctions in some versions (Electron 41's Node
 * 24.14 does), which would empty a linked project inside a bot's workspace or
 * a linked provider folder.
 */
export function removeTree(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    try {
      unlinkSync(path);
    } catch (error) {
      // A directory link on Windows is removed as a directory entry.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EISDIR') throw error;
      rmdirSync(path);
    }
    return;
  }
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) removeTree(join(path, name));
    rmdirSync(path);
    return;
  }
  try {
    unlinkSync(path);
  } catch (error) {
    // A read-only file, such as a git object on Windows.
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    chmodSync(path, 0o666);
    unlinkSync(path);
  }
}
