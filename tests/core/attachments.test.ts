import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { readAttachmentImage, storeAttachment } from '../../src/core/conversations/attachmentStore.ts';
import {
  MAX_ATTACHMENT_BYTES,
  attachedFilesMessage,
  attachmentName,
  extractAttachments,
  sanitizeAttachmentName,
  uniqueAttachmentName,
} from '../../src/shared/attachments.ts';

/** SPEC-003 FR-8: attachments in the bot's working directory, and the block that names them. */

function workspace(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'cats-bot-attachments-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the attachment block is written and read as Cats Desktop does', () => {
  const text = attachedFilesMessage('look at these', ['.cats-attachments/cat.png', '.cats-attachments/notes.txt']);
  assert.equal(text, '[Attached files in working directory:]\n- .cats-attachments/cat.png\n- .cats-attachments/notes.txt\n\nlook at these');
  assert.deepEqual(extractAttachments(text), {
    attachments: [
      { filename: 'cat.png', relativePath: '.cats-attachments/cat.png', isImage: true },
      { filename: 'notes.txt', relativePath: '.cats-attachments/notes.txt', isImage: false },
    ],
    text: 'look at these',
  });
  assert.equal(attachedFilesMessage('plain', []), 'plain');
  assert.deepEqual(extractAttachments('no block here'), { attachments: [], text: 'no block here' });
  assert.deepEqual(extractAttachments(attachedFilesMessage('', ['.cats-attachments/a.webp'])).text, '');
  // The core trims a message: files only, with the block's last newline gone.
  assert.deepEqual(extractAttachments(attachedFilesMessage('', ['.cats-attachments/a.webp', '.cats-attachments/b.txt']).trim()), {
    attachments: [
      { filename: 'a.webp', relativePath: '.cats-attachments/a.webp', isImage: true },
      { filename: 'b.txt', relativePath: '.cats-attachments/b.txt', isImage: false },
    ],
    text: '',
  });
  assert.deepEqual(extractAttachments(attachedFilesMessage('- a list\n- of things', ['.cats-attachments/a.png'])).text, '- a list\n- of things',
    'a list in the text is not taken for files');
});

test('names are made safe and never replace a stored file', () => {
  assert.equal(sanitizeAttachmentName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeAttachmentName('C:\\Users\\me\\report.pdf'), 'report.pdf');
  assert.equal(sanitizeAttachmentName('a<b>:c?.txt. '), 'a_b__c_.txt');
  assert.equal(sanitizeAttachmentName('..'), 'attachment');
  assert.equal(sanitizeAttachmentName('CON.txt'), '_CON.txt');
  assert.equal(sanitizeAttachmentName('nul'), '_nul');
  assert.equal(sanitizeAttachmentName('console.log'), 'console.log');
  const long = sanitizeAttachmentName(`${'貓'.repeat(100)}.png`);
  assert.ok(new TextEncoder().encode(long).length <= 200 && long.endsWith('.png'), long);
  assert.equal(uniqueAttachmentName('cat.png', (name) => ['cat.png', 'cat-2.png'].includes(name)), 'cat-3.png');
  assert.equal(attachmentName('.cats-attachments/cat.png'), 'cat.png');
  for (const path of ['.cats-attachments/../secret.png', '../.cats-attachments/cat.png', '/etc/cat.png', '.cats-attachments/a/b.png', '.cats-attachments/'])
    assert.equal(attachmentName(path), null, path);
});

test('a stored file goes to .cats-attachments, git-ignored, under a free name', (t) => {
  const cwd = workspace(t);
  const first = storeAttachment(cwd, 'cat.png', Buffer.from('one'));
  const second = storeAttachment(cwd, 'cat.png', Buffer.from('two'));
  assert.deepEqual(first, { name: 'cat.png', relativePath: '.cats-attachments/cat.png' });
  assert.deepEqual(second, { name: 'cat-2.png', relativePath: '.cats-attachments/cat-2.png' });
  assert.equal(readFileSync(join(cwd, '.cats-attachments', 'cat.png'), 'utf8'), 'one');
  assert.equal(readFileSync(join(cwd, '.cats-attachments', '.gitignore'), 'utf8'), '*\n');
  assert.equal(storeAttachment(cwd, '.gitignore', Buffer.from('x')).name, '.gitignore-2', 'the ignore file is never replaced');
  assert.equal(storeAttachment(cwd, 'empty.txt', Buffer.alloc(0)).name, 'empty.txt', 'an empty file is a file');
  assert.throws(() => storeAttachment(cwd, 'big.bin', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)), /at most 10 MB/u);
  assert.deepEqual(readdirSync(join(cwd, '.cats-attachments')).sort(), ['.gitignore', '.gitignore-2', 'cat-2.png', 'cat.png', 'empty.txt']);
});

test('a .cats-attachments that is a link is neither written to nor read from', (t) => {
  const cwd = workspace(t);
  const elsewhere = join(cwd, 'elsewhere');
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, 'private.png'), 'private');
  symlinkSync(elsewhere, join(cwd, '.cats-attachments'));
  assert.throws(() => storeAttachment(cwd, 'cat.png', Buffer.from('x')), /not a directory/u);
  assert.equal(readAttachmentImage(cwd, '.cats-attachments/private.png'), null);
  assert.deepEqual(readdirSync(elsewhere), ['private.png'], 'nothing was written through the link');
});

test('only a stored image inside the directory is read back for the note', (t) => {
  const cwd = workspace(t);
  storeAttachment(cwd, 'cat.png', Buffer.from('png bytes'));
  storeAttachment(cwd, 'notes.txt', Buffer.from('text'));
  assert.deepEqual(readAttachmentImage(cwd, '.cats-attachments/cat.png'), { mimeType: 'image/png', data: Buffer.from('png bytes').toString('base64') });
  assert.equal(readAttachmentImage(cwd, '.cats-attachments/notes.txt'), null, 'not an image');
  assert.equal(readAttachmentImage(cwd, '.cats-attachments/gone.png'), null, 'gone');
  assert.equal(readAttachmentImage(cwd, '../cat.png'), null, 'outside');
  const secret = join(cwd, 'secret.png');
  writeFileSync(secret, 'secret');
  symlinkSync(secret, join(cwd, '.cats-attachments', 'link.png'));
  assert.equal(readAttachmentImage(cwd, '.cats-attachments/link.png'), null, 'a link is not followed');
  mkdirSync(join(cwd, '.cats-attachments', 'dir.png'));
  assert.equal(readAttachmentImage(cwd, '.cats-attachments/dir.png'), null, 'a directory is not read');
});

test('an empty file passes the host channel too (SPEC-003 FR-8)', async () => {
  const { runCoreCommand } = await import('../../src/core/host-api/commands.ts');
  const calls: unknown[][] = [];
  const target = { addOwnerAttachment: async (...args: unknown[]) => { calls.push(args); return { name: 'empty.txt', relativePath: '.cats-attachments/empty.txt' }; } };
  await runCoreCommand(target as never, 'addOwnerAttachment', ['home', 'empty.txt', '']);
  assert.deepEqual(calls, [['home', 'empty.txt', '']]);
  await assert.rejects(runCoreCommand(target as never, 'addOwnerAttachment', ['home', 'big.bin', 'A'.repeat(14 * 1024 * 1024)]), /too long/u);
});
