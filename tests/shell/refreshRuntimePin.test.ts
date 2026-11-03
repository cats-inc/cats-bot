import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';

// CI scripts are intentionally plain JavaScript.
const { parseArgs, refreshRuntimePin } = await import(new URL('../../scripts/refresh-runtime-pin.mjs', import.meta.url).href);
const contract = await import(new URL('../../scripts/release-contract.mjs', import.meta.url).href);
const exec = promisify(execFile);
const oldArtifact = 'vendor/cats-runtime-0.6.1-old.tgz';
const readmeText = (record: string) => `# Runtime candidate\n\nBefore.\n\n<!-- runtime-pin:start -->\n${record}\n<!-- runtime-pin:end -->\n\nAfter.\n`;

/** A small real Runtime package in a Git repository, and a Bot root that pins an older one. Needs no network. */
async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'cats-refresh-pin-'));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 3 }));
  const source = join(home, 'runtime'), root = join(home, 'bot');
  await mkdir(source); await mkdir(join(root, 'vendor'), { recursive: true });
  const git = async (...args: string[]) => (await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd: source })).stdout.trim();
  const name = '@cats-inc/cats-runtime', version = '0.6.2';
  const write = (file: string, value: unknown) => writeFile(join(source, file), `${JSON.stringify(value, null, 2)}\n`);
  await git('init', '-q', '-b', 'main');
  await write('package.json', { name, version, scripts: { build: 'node build.mjs' }, files: ['build'] });
  await write('package-lock.json', { name, version, lockfileVersion: 3, requires: true, packages: { '': { name, version } } });
  await writeFile(join(source, 'build.mjs'), "import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('build', { recursive: true });\nwriteFileSync('build/index.js', 'export {};\\n');\n");
  await writeFile(join(source, '.gitignore'), 'build/\nnode_modules/\n*.tgz\n');
  const commit = async (subject: string, file: string) => {
    await writeFile(join(source, file), `${subject}\n`);
    await git('add', '.'); await git('commit', '-q', '-m', subject);
    return git('rev-parse', 'HEAD');
  };
  const first = await commit('feat: first (#1)', 'first.txt');

  const dependency = `file:${oldArtifact}`;
  const pkg = { name: '@cats-inc/cats-bot', version: '0.4.10', dependencies: { [name]: dependency } };
  await writeFile(join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  await writeFile(join(root, 'package-lock.json'), `${JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages: { '': pkg } }, null, 2)}\n`);
  await writeFile(join(root, oldArtifact), 'old tarball');
  await writeFile(join(root, 'vendor', 'runtime-source.json'), `${JSON.stringify({ schemaVersion: 1, repository: 'cats-inc/cats-runtime', commit: 'b'.repeat(40), version: '0.6.1', artifact: oldArtifact, sha256: 'c'.repeat(64) }, null, 2)}\n`);
  await writeFile(join(root, 'vendor', 'README.md'), readmeText('Old record.'));
  return { source, root, git, commit, first };
}

test('a refresh pins Runtime main and updates every record of it together', async t => {
  const f = await fixture(t);
  const head = await f.commit('fix: second (#2)', 'second.txt');
  const pin = await refreshRuntimePin({ root: f.root, source: f.source });
  assert.equal(pin.commit, head);
  assert.deepEqual(pin.missing, []);
  const artifact = `vendor/cats-runtime-0.6.2-${head.slice(0, 8)}.tgz`;
  assert.equal(pin.artifact, artifact);

  const input = await contract.validateInputs(f.root, 'v0.4.10');
  assert.deepEqual([input.runtime.commit, input.runtime.version, input.runtime.artifact, input.runtime.sha256], [head, '0.6.2', artifact, pin.sha256]);
  assert.equal(input.runtime.repository, 'cats-inc/cats-runtime');
  await assert.rejects(access(join(f.root, oldArtifact)), /ENOENT/u);

  const { stdout } = await exec('tar', ['-tzf', artifact], { cwd: f.root });
  assert.match(stdout, /package\/build\/index\.js/u, 'the package must contain the build output');

  assert.equal(await readFile(join(f.root, 'vendor', 'README.md'), 'utf8'), readmeText(
    `Source \`${head}\`, package version 0.6.2.\nArtifact: \`${artifact}\`; ${pin.size.toLocaleString('en-US')} bytes.\nSHA-256: \`${pin.sha256}\`.`));
});

test('an older commit on main is allowed and reports what it leaves out', async t => {
  const f = await fixture(t);
  await f.commit('fix: second (#2)', 'second.txt');
  const pin = await refreshRuntimePin({ root: f.root, source: f.source, ref: f.first });
  assert.equal(pin.commit, f.first);
  assert.deepEqual(pin.missing.map((change: { pull: string }) => change.pull), ['2']);
});

test('a commit off main is refused before anything in the Bot changes', async t => {
  const f = await fixture(t);
  await f.git('switch', '-q', '-c', 'fix/branch');
  const branchHead = await f.commit('fix: only on a branch', 'branch.txt');
  await f.git('switch', '-q', 'main');
  const before = await readFile(join(f.root, 'vendor', 'runtime-source.json'), 'utf8');
  await assert.rejects(refreshRuntimePin({ root: f.root, source: f.source, ref: branchHead }), /is not on origin\/main/u);
  assert.equal(await readFile(join(f.root, 'vendor', 'runtime-source.json'), 'utf8'), before);
  await access(join(f.root, oldArtifact));
});

test('a Bot without the record or the old dependency is refused before anything changes', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'vendor', 'README.md'), '# No record\n');
  await assert.rejects(refreshRuntimePin({ root: f.root, source: f.source }), /no runtime-pin record/u);
  await access(join(f.root, oldArtifact));
  await writeFile(join(f.root, 'vendor', 'README.md'), readmeText('Old record.'));
  await writeFile(join(f.root, 'package.json'), '{ "name": "@cats-inc/cats-bot", "version": "0.4.10" }\n');
  await assert.rejects(refreshRuntimePin({ root: f.root, source: f.source }), /must depend on/u);
  await access(join(f.root, oldArtifact));
});

test('Git tracks whichever Runtime tarball a refresh writes', async () => {
  const repository = new URL('../../', import.meta.url);
  await assert.rejects(exec('git', ['check-ignore', '--quiet', '--no-index', 'vendor/cats-runtime-9.9.9-abcdef12.tgz'], { cwd: repository }), (error: { code?: number }) => error.code === 1);
});

test('the command line accepts only its own options', () => {
  assert.deepEqual(parseArgs(['--ref', 'abc', '--source', 'path']), { help: false, ref: 'abc', source: 'path' });
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs(['--ref']), /needs a value/u);
  assert.throws(() => parseArgs(['--other']), /Unknown option/u);
});
