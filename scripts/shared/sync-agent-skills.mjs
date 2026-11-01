#!/usr/bin/env node
/** Safe repository skill synchronization. Usage: node sync-agent-skills.mjs --project-root DIR [--agent claude|codex] [--clean] [--dry-run] */
import { lstat, readdir, realpath, mkdir, cp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

async function exists(filename) {
  try { return await lstat(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function rejectLinks(filename) {
  const stat = await exists(filename);
  if (!stat) return;
  if (stat.isSymbolicLink()) throw new Error(`Refusing linked skill path: ${filename}`);
  if (stat.isDirectory()) for (const entry of await readdir(filename)) await rejectLinks(path.join(filename, entry));
}

export async function syncAgentSkills({ projectRoot, agent, dryRun = false }) {
  const root = await realpath(projectRoot);
  if (!(await exists(path.join(root, 'AGENTS.md')))?.isFile()) throw new Error('Project root must contain AGENTS.md.');
  const source = path.join(root, 'skills');
  if (!(await exists(source))?.isDirectory()) throw new Error('No canonical skills directory.');
  await rejectLinks(source);
  const skills = new Map();
  async function discover(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.toLowerCase().endsWith('.bootstrap')) continue;
      const child = path.join(directory, entry.name);
      if ((await exists(path.join(child, 'SKILL.md')))?.isFile()) {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry.name) || entry.name.length > 64)
          throw new Error(`Invalid skill directory: ${entry.name}`);
        const name = entry.name.toLowerCase();
        if (skills.has(name)) throw new Error(`Duplicate skill '${name}': ${skills.get(name)} and ${child}`);
        skills.set(name, child);
      } else await discover(child);
    }
  }
  await discover(source);
  if (agent && !['claude', 'codex'].includes(agent)) throw new Error('Agent must be claude or codex.');
  const hosts = agent ? [agent] : ['claude', 'codex'];
  const targets = hosts.map(host => path.join(root, host === 'claude' ? '.claude' : '.agents', 'skills'));
  // Complete preflight before changing either host, including unrelated destination skills.
  for (const target of targets) {
    const host = await exists(path.dirname(target));
    if (host?.isSymbolicLink()) throw new Error(`Refusing linked discovery root: ${path.dirname(target)}`);
    if (host && !host.isDirectory()) throw new Error(`Discovery host must be a directory: ${path.dirname(target)}`);
    const destination = await exists(target);
    if (destination && !destination.isSymbolicLink() && !destination.isDirectory()) throw new Error(`Discovery skills must be a directory: ${target}`);
    await rejectLinks(target);
  }
  if (dryRun) return { skills: [...skills.keys()], hosts, dryRun: true };
  for (const targetRoot of targets) {
    await mkdir(targetRoot, { recursive: true });
    for (const [name, sourceDir] of skills) {
      const destination = path.join(targetRoot, name);
      const staging = path.join(targetRoot, `.${name}-${randomUUID()}`);
      const backup = `${staging}.backup`;
      let moved = false;
      try {
        await cp(sourceDir, staging, { recursive: true, filter: file => !path.basename(file).toLowerCase().endsWith('.bootstrap') });
        if (await exists(destination)) { await rename(destination, backup); moved = true; }
        try { await rename(staging, destination); }
        catch (error) { if (moved) { await rename(backup, destination); moved = false; } throw error; }
        if (moved) await rm(backup, { recursive: true });
      } finally { await rm(staging, { recursive: true, force: true }); }
    }
  }
  return { skills: [...skills.keys()], hosts, dryRun: false };
}

export async function main(args = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (['--help', '-h'].includes(arg)) {
      console.log('Usage: sync-agent-skills --project-root DIR [--agent claude|codex] [--clean] [--dry-run]\n--clean preserves unrelated skills, like a normal sync.');
      return;
    }
    if (arg === '--clean') continue;
    if (arg === '--dry-run') { options.dryRun = true; continue; }
    if (!['--project-root', '--agent'].includes(arg) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Invalid option: ${arg}`);
    options[arg === '--project-root' ? 'projectRoot' : 'agent'] = args[++index];
  }
  if (!options.projectRoot) throw new Error('--project-root is required.');
  const result = await syncAgentSkills(options);
  console.log(`${result.dryRun ? 'Would sync' : 'Synced'} ${result.skills.length} skills to ${result.hosts.join(', ')}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
