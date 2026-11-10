import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';

import {
  ATTACHMENTS_DIRECTORY,
  MAX_ATTACHMENT_BYTES,
  attachmentImageType,
  attachmentName,
  sanitizeAttachmentName,
  uniqueAttachmentName,
} from '../../shared/attachments.ts';

/**
 * SPEC-003 FR-8: the owner's attachments in the bot's working directory, under
 * `.cats-attachments/` (git-ignored there), where the provider CLI reads them.
 * A name already taken gets a numbered one, so a file is never replaced.
 */

export interface StoredAttachment {
  name: string;
  relativePath: string;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

/** The directory itself, never a link: a link planted in the working directory would send files elsewhere. */
function isOwnDirectory(directory: string): boolean {
  const stat = lstatSync(directory);
  return stat.isDirectory() && !stat.isSymbolicLink();
}

export function storeAttachment(cwd: string, name: string, bytes: Buffer): StoredAttachment {
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`An attachment can be at most ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`);
  }
  const directory = join(cwd, ATTACHMENTS_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  if (!isOwnDirectory(directory)) throw new Error(`${ATTACHMENTS_DIRECTORY} in the working directory is not a directory`);
  try {
    writeFileSync(join(directory, '.gitignore'), '*\n', { flag: 'wx' });
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error;
  }
  const safe = sanitizeAttachmentName(name);
  for (;;) {
    const stored = uniqueAttachmentName(safe, (candidate) => candidate === '.gitignore' || exists(join(directory, candidate)));
    try {
      // `wx`: another write that took the name meanwhile is not replaced; the next name is tried.
      writeFileSync(join(directory, stored), bytes, { flag: 'wx' });
      return { name: stored, relativePath: `${ATTACHMENTS_DIRECTORY}/${stored}` };
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    }
  }
}

/** An attached image as the note shows it; null when the path is not a stored image, or it is gone. */
export function readAttachmentImage(cwd: string, relativePath: string): { mimeType: string; data: string } | null {
  const name = attachmentName(relativePath);
  const mimeType = name ? attachmentImageType(name) : null;
  if (!name || !mimeType) return null;
  const directory = join(cwd, ATTACHMENTS_DIRECTORY);
  const file = join(directory, name);
  try {
    if (!isOwnDirectory(directory)) return null;
    // A link could point anywhere; only a regular file inside the directory is read.
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) return null;
    if (!realpathSync(file).startsWith(realpathSync(directory) + sep)) return null;
    return { mimeType, data: readFileSync(file).toString('base64') };
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) return null;
    throw error;
  }
}
