/**
 * SPEC-003 FR-8: files the owner attaches to a note message, as Cats Desktop
 * sends them. Each file is written to `.cats-attachments/` in the bot's working
 * directory, and the message starts with a block that lists their paths, so
 * the provider CLI reads them with its own file tools. The block is part of the
 * message text: the transcript keeps no other record of attachments, and the
 * note shows the block as files. Pure rules, shared by the core and the note.
 */

export const ATTACHMENTS_DIRECTORY = '.cats-attachments';
/** Per file; one file travels in one host-channel request (16 MiB frames). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const HEADER = '[Attached files in working directory:]';
// The last path may end the text: the core trims a message, and a message of files only is the block alone.
const BLOCK = /^\[Attached files in working directory:\]\n((?:- [^\n]+(?:\n|$))+)\n?/u;
/** Windows device names, which no file may have whatever its extension. */
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
/** Bytes of a file name, below the 255 most file systems allow. */
const MAX_NAME_BYTES = 200;

/** Images the note shows inline, by extension. */
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export interface MessageAttachment {
  filename: string;
  relativePath: string;
  isImage: boolean;
}

function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** The image type of a file name, or null when the note does not show it inline. */
export function attachmentImageType(name: string): string | null {
  return IMAGE_TYPES[extension(name)] ?? null;
}

function shortened(name: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(name).length <= MAX_NAME_BYTES) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && encoder.encode(name.slice(dot)).length <= 20 ? name.slice(dot) : '';
  let base = '';
  for (const character of name.slice(0, name.length - ext.length)) {
    if (encoder.encode(base + character + ext).length > MAX_NAME_BYTES) break;
    base += character;
  }
  return base + ext;
}

/**
 * A file name safe on every platform: no directories, reserved characters, trailing dots and spaces or
 * Windows device names, and short enough for the file system.
 */
export function sanitizeAttachmentName(raw: string): string {
  const base = (typeof raw === 'string' ? raw : '').split(/[\\/]/u).pop() ?? '';
  const normalized = base.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').replace(/[. ]+$/gu, '');
  if (!normalized || normalized === '.' || normalized === '..') return 'attachment';
  return shortened(RESERVED.test(normalized) ? `_${normalized}` : normalized);
}

/** `name`, or `name-2`, `name-3`… before the extension: the first that `taken` does not hold. */
export function uniqueAttachmentName(name: string, taken: (candidate: string) => boolean): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let attempt = 1; ; attempt++) {
    const candidate = attempt === 1 ? name : `${base}-${attempt}${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

/** The relative path of a stored attachment, or null when the path is anything else. */
export function attachmentName(relativePath: string): string | null {
  const prefix = `${ATTACHMENTS_DIRECTORY}/`;
  if (!relativePath.startsWith(prefix)) return null;
  const name = relativePath.slice(prefix.length);
  return name && sanitizeAttachmentName(name) === name ? name : null;
}

/** The message text with the attachment block in front, as Cats Desktop writes it. */
export function attachedFilesMessage(text: string, relativePaths: readonly string[]): string {
  if (relativePaths.length === 0) return text;
  return `${HEADER}\n${relativePaths.map((path) => `- ${path}`).join('\n')}\n\n${text}`;
}

/** Splits a message into its attachments and the text after their block. */
export function extractAttachments(text: string): { attachments: MessageAttachment[]; text: string } {
  const match = BLOCK.exec(text);
  if (!match) return { attachments: [], text };
  const attachments = match[1]!.split('\n').map((line) => line.replace(/^- /u, '').trim()).filter(Boolean)
    .map((relativePath) => {
      const filename = relativePath.split('/').pop() ?? relativePath;
      return { filename, relativePath, isImage: attachmentImageType(filename) !== null };
    });
  return { attachments, text: text.slice(match[0].length) };
}
