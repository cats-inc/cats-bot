#!/usr/bin/env node
/** Build the Runtime artifact from a commit on Runtime main and update every record of it. Usage: node scripts/refresh-runtime-pin.mjs [--ref REF] [--source GIT_URL_OR_PATH] */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { validateInputs } from './release-contract.mjs';
import { digest } from './shared/release-primitives.mjs';
import { missingSourceChanges } from './shared/source-selection.mjs';

const exec = promisify(execFile);
const SCRIPT = fileURLToPath(import.meta.url);
const RUNTIME_URL = 'https://github.com/cats-inc/cats-runtime.git';
const RECORD = /<!-- runtime-pin:start -->[\s\S]*?<!-- runtime-pin:end -->/u;
const run = async (command, args, cwd) => (await exec(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 900_000 })).stdout.trim();
const git = (cwd, ...args) => run('git', ['--no-replace-objects', ...args], cwd);
// npm is a batch file on Windows, which execFile cannot start directly. Every argument here is a fixed flag.
const npm = (cwd, ...args) => process.platform === 'win32' ? run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args], cwd) : run('npm', args, cwd);

/** Packs one commit from a clean clone, so the bytes do not depend on a local checkout or its line-ending settings. */
export async function packRuntime({ source, ref, workspace }) {
  const clone = join(workspace, 'runtime');
  await git(workspace, 'clone', '--quiet', '--no-checkout', '--config', 'core.autocrlf=false', '--config', 'core.eol=lf', source, clone);
  const commit = await git(clone, 'rev-parse', '--verify', `${ref}^{commit}`);
  const missing = await missingSourceChanges(clone, commit);
  await git(clone, 'checkout', '--quiet', '--detach', commit);
  await npm(clone, 'ci', '--no-audit', '--no-fund');
  await npm(clone, 'run', 'build');
  // npm 11 reports a list and npm 12 an object keyed by package name.
  const [{ filename, version }] = Object.values(JSON.parse(await npm(clone, 'pack', '--ignore-scripts', '--json')));
  return { commit, version, missing, bytes: await readFile(join(clone, filename)) };
}

export async function refreshRuntimePin({ root, source = RUNTIME_URL, ref = 'origin/main' }) {
  const manifestPath = join(root, 'vendor', 'runtime-source.json');
  const packagePath = join(root, 'package.json');
  const readmePath = join(root, 'vendor', 'README.md');
  const previous = JSON.parse(await readFile(manifestPath, 'utf8'));
  const packageText = await readFile(packagePath, 'utf8');
  const readme = await readFile(readmePath, 'utf8');
  const dependency = `file:${previous.artifact}`;
  if (packageText.split(dependency).length !== 2) throw new Error(`package.json must depend on ${dependency} exactly once.`);
  if (!RECORD.test(readme)) throw new Error('vendor/README.md has no runtime-pin record to update.');
  const workspace = await mkdtemp(join(tmpdir(), 'cats-runtime-pin-'));
  try {
    const { commit, version, missing, bytes } = await packRuntime({ source, ref, workspace });
    const artifact = `vendor/cats-runtime-${version}-${commit.slice(0, 8)}.tgz`;
    const sha256 = digest(bytes);
    await writeFile(join(root, artifact), bytes);
    if (previous.artifact !== artifact) await rm(join(root, previous.artifact), { force: true });
    await writeFile(manifestPath, `${JSON.stringify({ ...previous, commit, version, artifact, sha256 }, null, 2)}\n`);
    await writeFile(packagePath, packageText.replace(dependency, () => `file:${artifact}`));
    await writeFile(readmePath, readme.replace(RECORD, () => ['<!-- runtime-pin:start -->', `Source \`${commit}\`, package version ${version}.`,
      `Artifact: \`${artifact}\`; ${bytes.length.toLocaleString('en-US')} bytes.`, `SHA-256: \`${sha256}\`.`, '<!-- runtime-pin:end -->'].join('\n')));
    await npm(root, 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund');
    await validateInputs(root, `v${JSON.parse(await readFile(packagePath, 'utf8')).version}`);
    return { commit, version, artifact, sha256, size: bytes.length, missing };
  } finally {
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  }
}

export function parseArgs(argv) {
  const options = { help: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--help' || argv[index] === '-h') options.help = true;
    else if (argv[index] === '--ref' || argv[index] === '--source') {
      if (!argv[index + 1]) throw new Error(`${argv[index]} needs a value.`);
      options[argv[index].slice(2)] = argv[index += 1];
    } else throw new Error(`Unknown option: ${argv[index]}`);
  }
  return options;
}

async function main() {
  const { help, ...options } = parseArgs(process.argv.slice(2));
  if (help) {
    process.stdout.write(`Usage: node scripts/refresh-runtime-pin.mjs [--ref REF] [--source GIT_URL_OR_PATH]

Builds the Runtime package from a clean clone and updates vendor/runtime-source.json,
the tarball, package.json, package-lock.json and the record in vendor/README.md.
REF defaults to origin/main and must be on Runtime main. Use an older REF only to hold
changes back; the release notes must then list each one on a "Left out of this release:"
line, or the preview guard refuses it.
`);
    return;
  }
  const pin = await refreshRuntimePin({ root: resolve(dirname(SCRIPT), '..'), ...options });
  process.stdout.write(`Runtime ${pin.version} ${pin.commit}\n${pin.artifact}, ${pin.size} bytes, SHA-256 ${pin.sha256}\n`);
  process.stdout.write(pin.missing.length === 0 ? 'Runtime main has nothing else to include.\n'
    : `The release notes must list these on a "Left out of this release:" line, with the reason:\n${pin.missing.map(({ sha, subject, pull }) => `  ${pull === null ? sha.slice(0, 8) : `cats-runtime#${pull}`} ${subject}`).join('\n')}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  main().catch(error => { process.stderr.write(`${error.stderr || error.message}\n`); process.exitCode = 1; });
}
