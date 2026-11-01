#!/usr/bin/env node
/** Check or refresh pinned tool sources. Usage: node scripts/sync-shared-tools.mjs [--manifest FILE] [--source repository=CHECKOUT] [--refresh] */
import { readFile, writeFile, lstat, realpath, mkdir, rename, chmod } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function contained(root, relative, missing = false) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || /[:\x00-\x1f]/u.test(relative) || path.posix.isAbsolute(relative)
    || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Unsafe tool path: ${relative}`);
  let cursor = root;
  for (const part of relative.split('/')) {
    cursor = path.join(cursor, part);
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`Linked tool path: ${cursor}`); }
    catch (error) { if (!missing || error.code !== 'ENOENT') throw error; }
  }
  return cursor;
}

export async function syncSharedTools({ root = process.cwd(), manifest = 'scripts/shared-tools.provenance.json', sources = {}, refresh = false }) {
  root = await realpath(root);
  const filename = await contained(root, manifest);
  const document = JSON.parse(await readFile(filename, 'utf8'));
  // Also accept the existing provider-helper provenance format.
  const groups = document.sources ?? [document];
  const destinationRoot = document.sources ? root : path.dirname(filename);
  if (!Array.isArray(groups) || !groups.length) throw new Error('No pinned tool sources.');
  const operations = [], seen = new Set();
  for (const group of groups) {
    if (typeof group.repository !== 'string' || !Array.isArray(group.files) || !group.files.length || !/^[a-f0-9]{40}$/u.test(group.commit)) throw new Error('Invalid source pin.');
    const id = group.repository.replace(/^https:\/\/github.com\//u, '').replace(/\.git$/u, '');
    const supplied = sources[id] ?? sources[group.repository];
    if (refresh && !supplied) throw new Error(`--refresh requires --source ${id}=CHECKOUT`);
    const sourceRoot = supplied ? await realpath(supplied) : null;
    const git = async (...args) => (await exec('git', ['--no-replace-objects', ...args], { cwd: sourceRoot, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })).stdout;
    const commit = refresh ? (await git('rev-parse', 'HEAD')).toString().trim() : group.commit;
    for (const file of group.files) {
      if (seen.has(file.path) || !/^[a-f0-9]{64}$/u.test(file.sha256)) throw new Error(`Duplicate or invalid source row: ${file.path}`);
      seen.add(file.path);
      const destination = await contained(destinationRoot, file.path, refresh);
      if (sourceRoot) {
        const source = await contained(sourceRoot, file.source);
        const committed = await git('show', `${commit}:${file.source}`);
        if (refresh && !committed.equals(await readFile(source))) throw new Error(`Commit source changes before refreshing: ${file.source}`);
        const digest = hash(committed);
        if (refresh) {
          file.sha256 = digest;
          const mode = (await git('ls-tree', commit, '--', file.source)).toString().split(' ')[0];
          file.executable = mode === '100755';
          operations.push({ destination, bytes: committed, executable: file.executable });
        } else if (digest !== file.sha256) throw new Error(`Pinned source differs: ${file.source}`);
      }
      if (!refresh && hash(await readFile(destination)) !== file.sha256) throw new Error(`Tool drift: ${file.path}`);
      if (!refresh && process.platform !== 'win32' && typeof file.executable === 'boolean'
        && Boolean((await lstat(destination)).mode & 0o100) !== file.executable) throw new Error(`Tool executable mode drift: ${file.path}`);
    }
    if (refresh) group.commit = commit;
  }
  if (refresh) {
    for (const { destination, bytes, executable } of operations) {
      await mkdir(path.dirname(destination), { recursive: true });
      const temporary = `${destination}.${randomUUID()}.tmp`;
      await writeFile(temporary, bytes, { mode: executable ? 0o755 : 0o644 });
      await rename(temporary, destination);
      await chmod(destination, executable ? 0o755 : 0o644);
    }
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`);
    await rename(temporary, filename);
  }
  return { files: seen.size, refreshed: refresh };
}

export async function main(args = process.argv.slice(2)) {
  const options = { sources: {} };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/sync-shared-tools.mjs [--manifest FILE] [--source repository=CHECKOUT] [--refresh]\nDefault: verify local hashes without siblings or writes. --source also verifies pinned Git objects; --refresh requires committed sources.');
      return;
    }
    if (arg === '--refresh') { options.refresh = true; continue; }
    if (!['--manifest', '--source'].includes(arg) || !args[index + 1]) throw new Error(`Invalid option: ${arg}`);
    const value = args[++index];
    if (arg === '--manifest') options.manifest = value;
    else { const split = value.indexOf('='); if (split < 1) throw new Error('--source requires repository=CHECKOUT'); options.sources[value.slice(0, split)] = value.slice(split + 1); }
  }
  const result = await syncSharedTools(options);
  console.log(`${result.refreshed ? 'Refreshed' : 'Verified'} ${result.files} pinned tool files.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
