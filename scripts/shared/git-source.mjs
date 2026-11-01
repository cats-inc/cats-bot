#!/usr/bin/env node
/** Read exact Git blobs for source archives; ignores worktree filters and export-ignore. Usage: node git-source.mjs CHECKOUT FULL_SHA */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/u;
const MAX_BYTES = 256 * 1024 * 1024;
const safePath = name => typeof name === 'string' && name.length > 0 && !name.includes('\\') && !name.includes(':') && !name.startsWith('/') && !/[\x00-\x1f]/u.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..');
async function run(command, args, cwd, options = {}) {
  const { input, ...execOptions } = options;
  const pending = execute(command, args, { cwd, maxBuffer: MAX_BYTES, timeout: 180_000, ...execOptions });
  if (input !== undefined) pending.child.stdin.end(input);
  return (await pending).stdout;
}
export async function archiveRepository(root, commit, repository, directory) {
  assert.match(commit, SHA, 'Source commit must be immutable');
  assert.ok(safePath(directory), 'Invalid source directory');
  const tree = await run('git', ['--no-replace-objects', 'ls-tree', '-rz', '--full-tree', commit], root);
  const tracked = tree.split('\0').filter(Boolean).map((entry) => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
    assert.ok(match && safePath(match[3]), 'Unsupported source entry: symlinks/submodules need explicit source handling');
    return { mode: match[1], blob: match[2], name: match[3] };
  });
  // Read blobs directly: git archive can apply autocrlf, export-ignore and
  // export-subst. None of those should alter the exact committed source bytes.
  const ids = [...new Set(tracked.map((entry) => entry.blob))];
  const packed = await run('git', ['--no-replace-objects', 'cat-file', '--batch'], root,
    { encoding: 'buffer', input: `${ids.join('\n')}\n` });
  const blobs = new Map();
  let offset = 0;
  for (const id of ids) {
    const newline = packed.indexOf(10, offset);
    assert.ok(newline >= offset, 'Incomplete Git blob header');
    const header = /^([a-f0-9]{40}) blob (\d+)$/.exec(packed.subarray(offset, newline).toString());
    assert.ok(header && header[1] === id, 'Unexpected Git blob response');
    const length = Number(header[2]);
    const start = newline + 1;
    assert.ok(Number.isSafeInteger(length) && length >= 0 && start + length < packed.length && packed[start + length] === 10, 'Incomplete Git blob');
    const bytes = packed.subarray(start, start + length);
    assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), id, 'Git blob identity mismatch');
    blobs.set(id, bytes);
    offset = start + length + 1;
  }
  assert.equal(offset, packed.length, 'Unexpected trailing Git blob data');
  const files = Object.create(null);
  for (const { name, mode, blob } of tracked) {
    files[name] = { bytes: blobs.get(blob), mode };
  }
  assert.ok(files['LICENSE'] && files['package.json'] && files['package-lock.json'], 'Repository source/license/lock missing');
  return { repository, commit, directory, files };
}


if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: node git-source.mjs CHECKOUT FULL_SHA');
    const repo = await archiveRepository(process.argv[2], process.argv[3], 'source', 'source');
    console.log(JSON.stringify(Object.entries(repo.files).map(([name, value]) => ({ name, mode: value.mode, data: value.bytes.toString('base64') }))));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
