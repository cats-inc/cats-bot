/** Isolated source snapshots and sanitized build environments for Desktop and Bot candidates. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, realpath, lstat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = async filename => JSON.parse(await readFile(filename, 'utf8'));
export function candidateEnvironment(base) {
  // Keep OS/session essentials, never inherited provider tokens, Node injection,
  // Cats endpoints, config overrides or the controller's selected provider state.
  return Object.fromEntries(Object.entries(base).filter(([key, value]) => value !== undefined
    && /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|PROGRAMFILES(?:\(X86\))?|PROGRAMDATA|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|DBUS_SESSION_BUS_ADDRESS|XDG_(?:RUNTIME_DIR|CONFIG_HOME|DATA_HOME|STATE_HOME|CACHE_HOME)|LANG|LC_.*)$/iu.test(key)));
}

export function within(root, child) {
  const relative = path.relative(root, child);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

const sourceDirectories = new Set(['src', 'desktop', 'packages', 'config', 'assets', 'public', 'scripts', 'runtime-skills', 'vendor', 'native']);
const sourceFiles = /^(?:package(?:-lock)?\.json|tsconfig(?:\.[\w-]+)?\.json|vite\.config\.ts|index\.html|tailwind\.runtime\.config\.cjs)$/u;

export async function snapshotCandidateSource(source, target, dependencySource = source) {
  const git = async (...args) => (await exec('git', args, { cwd: source, windowsHide: true,
    maxBuffer: 16 * 1024 * 1024 })).stdout;
  const head = (await git('rev-parse', 'HEAD')).trim();
  const gitCommonDirectory = await realpath((await git('rev-parse', '--path-format=absolute', '--git-common-dir')).trim());
  const dirty = Boolean(await git('status', '--porcelain', '-z'));
  const filenames = [...new Set((await git('ls-files', '--cached', '--others', '--exclude-standard', '-z'))
    .split('\0').filter(Boolean))].sort();
  const digest = createHash('sha256');
  let files = 0;
  const checked = new Set();
  for (const filename of filenames) {
    if (!sourceDirectories.has(filename.split('/')[0]) && !sourceFiles.test(filename)) continue;
    if (filename.split('/').some((part) => part === '.env' || part.startsWith('.env.'))) continue;
    const origin = path.resolve(source, filename);
    if (!within(source, origin) || !within(target, path.resolve(target, filename))) throw new Error('Invalid source path.');
    // Git input symlinks/junctions must not pull in another profile. Explicit
    // dependency links below are the only shared filesystem input.
    let missing = false;
    for (let current = origin; current !== source; current = path.dirname(current)) {
      if (checked.has(current)) break;
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new Error(`Linked source input: ${filename}`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        missing = true; // A tracked file deleted in the working tree stays deleted.
        break;
      }
      checked.add(current);
    }
    if (missing) continue;
    const bytes = await readFile(origin);
    const destination = path.join(target, filename);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    digest.update(filename).update('\0').update(sha256(bytes)).update('\0');
    files += 1;
  }
  const dependencyRoot = await realpath(dependencySource);
  const dependencyLockDigest = sha256(await readFile(path.join(target, 'package-lock.json')));
  const packageDigest = sha256(await readFile(path.join(target, 'package.json')));
  if (sha256(await readFile(path.join(dependencyRoot, 'package-lock.json'))) !== dependencyLockDigest
    || sha256(await readFile(path.join(dependencyRoot, 'package.json'))) !== packageDigest) {
    throw new Error('Dependency checkout package/lock differs from candidate inputs; prepare matching dependencies before building.');
  }
  const dependencies = await realpath(path.join(dependencyRoot, 'node_modules'));
  await symlink(dependencies, path.join(target, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  return { checkout: source, gitCommonDirectory, head, dirty, files, sourceDigest: digest.digest('hex'),
    dependencyRoot, dependencies, dependencyLockDigest, packageDigest };
}
