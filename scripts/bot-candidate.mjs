#!/usr/bin/env node
/** Build and inspect an isolated source candidate. Usage: node scripts/bot-candidate.mjs start --root NEW_DIRECTORY [--workspace CHECKOUT] [--dependencies CHECKOUT] [--electron EXECUTABLE]; node scripts/bot-candidate.mjs <status|screenshot|stop|evidence> --root DIRECTORY */
import { mkdir, writeFile, rename, open, realpath, symlink } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateEnvironment, snapshotCandidateSource, within } from './shared/source-candidate.mjs';
import { operateCandidate, readCandidateControl } from './shared/candidate-control.mjs';
export { operateCandidate } from './shared/candidate-control.mjs';
const execute = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export function parseArgs(args) {
  const [command, ...rest] = args;
  if (['--help', '-h'].includes(command)) return { command: 'help' };
  if (!['start', 'status', 'screenshot', 'stop', 'evidence'].includes(command)) throw new Error('Expected start, status, screenshot, stop or evidence.');
  const options = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]?.slice(2), value = rest[index + 1];
    if (!rest[index]?.startsWith('--') || !['root', ...(command === 'start' ? ['workspace', 'dependencies', 'electron'] : [])].includes(key) || !value || value.startsWith('--') || options[key]) throw new Error('Invalid or repeated candidate option.');
    options[key] = value;
  }
  if (!options.root) throw new Error('--root is required.');
  options.root = path.resolve(options.root);
  return options;
}
export async function startCandidate(options) {
  const source = await realpath(options.workspace ?? process.cwd());
  const dependencies = await realpath(options.dependencies ?? source);
  const root = path.join(await realpath(path.dirname(options.root)), path.basename(options.root));
  if ([source, dependencies].some(checkout => within(checkout, root) || within(root, checkout))) throw new Error('Candidate root must be outside source/dependency checkouts.');
  await mkdir(root, { mode: 0o700 }); // A previous candidate is never reused or deleted.
  const token = randomBytes(32).toString('hex');
  const launch = { schemaVersion: 1, root, launchId: createHash('sha256').update(token).digest('hex'), stage: 'building', sources: {} };
  const save = async () => { await writeFile(path.join(root, 'launch.json.tmp'), JSON.stringify(launch, null, 2) + '\n', { mode: 0o600 }); await rename(path.join(root, 'launch.json.tmp'), path.join(root, 'launch.json')); };
  await save();
  const environment = candidateEnvironment(process.env);
  await mkdir(path.join(root, 'tmp'));
  const env = { ...environment, TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TMPDIR: path.join(root, 'tmp') };
  const snapshot = path.join(root, 'source', 'cats-bot');
  try {
    launch.sources.bot = await snapshotCandidateSource(source, snapshot, dependencies);
    const require = createRequire(path.join(snapshot, 'package.json'));
    if (require('./package.json').name !== '@cats-inc/cats-bot') throw new Error('Expected a Cats Bot checkout.');
    for (const args of [['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], ['node_modules/vite/bin/vite.js', 'build']])
      await execute(process.execPath, args, { cwd: snapshot, env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
    const host = path.join(root, 'host');
    await mkdir(host);
    await writeFile(path.join(host, 'package.json'), JSON.stringify({ name: 'cats-bot-candidate', version: require('./package.json').version,
      main: '../source/cats-bot/scripts/candidate-electron-host.mjs' }));
    for (const name of ['assets', 'dist']) await symlink(path.join(snapshot, name), path.join(host, name), process.platform === 'win32' ? 'junction' : 'dir');
    launch.stage = 'launching'; await save();
    const log = await open(path.join(root, 'bot.log'), 'a', 0o600);
    try {
      const child = spawn(options.electron ?? require('electron'), [host, `--user-data-dir=${path.join(root, 'user-data')}`], {
        cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd], windowsHide: true,
        env: { ...env, CATS_BOT_HOME: path.join(root, 'bot-home'), CATS_BOT_CANDIDATE_ROOT: root, CATS_BOT_CANDIDATE_TOKEN: token },
      });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
    } finally { await log.close(); }
    for (const deadline = Date.now() + 60_000; Date.now() < deadline; await pause(250)) {
      try {
        await readCandidateControl(root);
        const status = await operateCandidate('status', root);
        if (status.state === 'failed' || status.state === 'drained') throw new Error('Candidate exited before readiness; inspect bot.log.');
        if (status.window && !status.window.loading) { launch.stage = 'running'; await save(); return { ...status, launch }; }
      } catch (error) { if (error.code !== 'ENOENT' && !['fetch failed', 'The operation was aborted due to timeout'].includes(error.message)) throw error; }
    }
    throw new Error('Candidate did not become ready; inspect bot.log.');
  } catch (error) {
    if (launch.stage === 'launching') { try { await operateCandidate('stop', root); } catch (cleanup) { console.error(`Candidate cleanup unconfirmed: ${cleanup.message}`); } }
    launch.stage = 'failed'; await save(); throw error;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const options = parseArgs(process.argv.slice(2)); console.log(options.command === 'help'
    ? 'Usage: bot-candidate.mjs start --root NEW_DIRECTORY [--workspace CHECKOUT] [--dependencies CHECKOUT] [--electron EXECUTABLE]\n       bot-candidate.mjs <status|screenshot|stop|evidence> --root DIRECTORY'
    : JSON.stringify(options.command === 'start' ? await startCandidate(options) : await operateCandidate(options.command, options.root), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
