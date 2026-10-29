import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parse } from 'yaml';

import { parseBotRelease, UPDATE_REPOSITORY } from '../../src/shell/electron/update/release.ts';

// CI scripts are intentionally plain JavaScript, also loaded by github-script.
const contract = await import(new URL('../../scripts/release-contract.mjs', import.meta.url).href);
const { guardRelease } = await import(new URL('../../scripts/release-github.mjs', import.meta.url).href);
const sourceCommit = 'a'.repeat(40);
async function inputs(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cats-release-')); t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = { schemaVersion: 1, repository: 'cats-inc/cats-runtime', commit: 'b'.repeat(40), version: '0.6.2',
    artifact: 'vendor/cats-runtime-0.6.2-test.tgz', sha256: contract.digest('tarball fixture') };
  const dependency = `file:${runtime.artifact}`;
  const pkg = { version: '0.3.0', dependencies: { '@cats-inc/cats-runtime': dependency } };
  const lock = { version: '0.3.0', packages: { '': pkg, 'node_modules/@cats-inc/cats-runtime': { version: runtime.version,
    resolved: dependency, integrity: `sha512-${contract.digest('tarball fixture', 'sha512', 'base64')}` } } };
  await mkdir(join(root, 'vendor')); await mkdir(join(root, 'docs', 'releases'), { recursive: true });
  const json = async (path: string, value: unknown) => writeFile(join(root, path), JSON.stringify(value));
  await json('package.json', pkg); await json('package-lock.json', lock); await json('vendor/runtime-source.json', runtime);
  await writeFile(join(root, runtime.artifact), 'tarball fixture');
  await writeFile(join(root, 'docs/releases/v0.3.0.md'), 'Prepared compatibility, migration, source pins, signing and release changes. '.repeat(3));
  return { root, runtime, pkg, lock, json, input: await contract.validateInputs(root, 'v0.3.0', true) };
}

test('release inputs require exact versions, immutable Runtime checksum and schema-compatible version floor', async t => {
  const f = await inputs(t);
  await assert.rejects(contract.validateInputs(f.root, 'v0.3.0-preview', true), /exact/u);
  await assert.rejects(contract.validateInputs(f.root, 'v0.4.0', true), /must match/u);
  await writeFile(join(f.root, f.runtime.artifact), 'changed tarball');
  await assert.rejects(contract.validateInputs(f.root, 'v0.3.0', true), /checksum/u);
  f.pkg.version = '0.1.0'; f.lock.version = '0.1.0';
  await f.json('package.json', f.pkg); await f.json('package-lock.json', f.lock);
  await assert.rejects(contract.validateInputs(f.root, 'v0.1.0', true), /schema 2/u);
});

test('plain-version preview publication is monotonic; incomplete signing inputs fail closed', () => {
  assert.throws(() => contract.assertNewerRelease('v0.3.0', [{ draft: false, tag_name: 'v0.10.0' }]), /must exceed/u);
  assert.throws(() => contract.assertNewerRelease('v0.3.0', [{ draft: false, tag_name: 'v0.3.0' }]), /must exceed/u);
  contract.assertNewerRelease('v0.3.0', [{ draft: true, tag_name: 'v0.9.0' }, { draft: false, tag_name: 'v0.2.0' }]);
  assert.equal(contract.signingTrust('windows', {}), 'unsigned-no-certificate');
  assert.equal(contract.signingTrust('linux', {}), 'not-applicable');
  assert.throws(() => contract.signingTrust('macos', { CSC_LINK: 'cert' }), /complete/u);
  assert.throws(() => contract.signingTrust('windows', { WIN_CSC_KEY_PASSWORD: 'password' }), /no certificate/u);
  assert.equal(contract.signingTrust('macos', { CSC_LINK: 'cert', CSC_KEY_PASSWORD: 'pass', APPLE_API_KEY: 'key', APPLE_API_KEY_ID: 'id', APPLE_API_ISSUER: 'issuer' }), 'signed-notarized');
});

test('the release contract, packaged identity check and preview workflow name one repository (SPEC-007 FR-7)', async t => {
  const f = await inputs(t);
  assert.equal(contract.repository, UPDATE_REPOSITORY);
  for (const [platform, os, trust] of [['windows', 'win32', 'unsigned-no-certificate'], ['macos', 'darwin', 'signed-notarized'], ['linux', 'linux', 'not-applicable']] as const) {
    assert.ok(parseBotRelease(contract.descriptor(f.input, platform, sourceCommit, trust), '0.3.0', os, 'x64'), platform);
  }
  const workflow = parse(await readFile(new URL('../../.github/workflows/bot-preview.yml', import.meta.url), 'utf8'));
  assert.equal(workflow.name, contract.workflowName, 'scripts/build-preview.mjs only publishes from this workflow name');
});

test('release guard only resumes its own draft and rejects reused tags, publication and drift', async t => {
  const f = await inputs(t);
  let releases: object[] = [], tagged = false;
  const github = { paginate: async () => releases, rest: { repos: { listReleases: () => undefined }, git: { getRef: async () => {
    if (tagged) return { data: {} }; throw Object.assign(new Error('not found'), { status: 404 });
  } } } };
  const guard = () => guardRelease({ github, root: f.root, tag: 'v0.3.0', sourceCommit });
  assert.equal((await guard()).existing, undefined);
  const draft = { draft: true, tag_name: 'v0.3.0', target_commitish: sourceCommit, body: `Source commit: \`${sourceCommit}\`` };
  releases = [draft]; assert.equal((await guard()).existing, draft);
  tagged = true; await assert.rejects(guard(), /tag already exists/u); tagged = false;
  releases = [{ ...draft, target_commitish: 'c'.repeat(40) }]; await assert.rejects(guard(), /Refusing/u);
  releases = [{ ...draft, draft: false }]; await assert.rejects(guard(), /must exceed/u);
});

test('complete assets verify bytes, architecture metadata, source bundle and packaged identity', async t => {
  const { root, input } = await inputs(t); const dir = join(root, 'assets'); await mkdir(dir);
  const binary = ['setup-x64.exe', 'setup-arm64.exe', 'portable-x64.exe', 'portable-arm64.exe', 'universal.dmg', 'universal.zip', 'amd64.deb', 'arm64.deb'];
  const prefix = 'Cats-Bot-0.3.0-';
  for (const name of binary) await writeFile(join(dir, prefix + name), name);
  const metadata = (names: string[]) => ({ version: '0.3.0', files: names.map(name => ({ url: prefix + name, size: Buffer.byteLength(name), sha512: contract.digest(name, 'sha512', 'base64') })),
    path: prefix + names[0], sha512: contract.digest(names[0], 'sha512', 'base64') });
  const feeds = { 'latest.yml': ['setup-x64.exe', 'setup-arm64.exe'], 'latest-mac.yml': ['universal.zip', 'universal.dmg'], 'latest-linux.yml': ['amd64.deb'], 'latest-linux-arm64.yml': ['arm64.deb'] };
  for (const [name, names] of Object.entries(feeds)) await writeFile(join(dir, name), JSON.stringify(metadata(names)));
  for (const platform of ['windows', 'macos', 'linux']) await writeFile(join(dir, `Cats-Bot-v0.3.0-${platform}-build.json`), JSON.stringify(contract.descriptor(input, platform, sourceCommit, platform === 'linux' ? 'not-applicable' : 'unsigned-no-certificate')));
  await writeFile(join(dir, 'Cats-Bot-v0.3.0-source.zip'), 'complete source');
  await writeFile(join(dir, 'Cats-Bot-v0.3.0-sources.json'), JSON.stringify({ sourceCommit, runtimeCommit: input.runtime.commit, runtimeSha256: input.runtime.sha256, archiveSha256: contract.digest('complete source') }));
  await contract.validateAssets(dir, input, sourceCommit);
  assert.match(await readFile(join(dir, 'SHA256SUMS'), 'utf8'), /setup-arm64.exe/u);
  await writeFile(join(dir, 'latest.yml'), JSON.stringify(metadata(['setup-x64.exe'])));
  await assert.rejects(contract.validateAssets(dir, input, sourceCommit), /omits.*arm64/u);
  await writeFile(join(dir, 'latest.yml'), JSON.stringify(metadata(['setup-x64.exe', 'setup-arm64.exe'])));
  await writeFile(join(dir, prefix + 'universal.zip'), 'corrupt');
  await assert.rejects(contract.validateAssets(dir, input, sourceCommit), /checksum/u);
  await writeFile(join(dir, prefix + 'universal.zip'), 'universal.zip');
  const bad = metadata(['setup-x64.exe']); bad.files[0]!.url = '../escape.exe';
  await writeFile(join(dir, 'latest.yml'), JSON.stringify(bad));
  await assert.rejects(contract.validateAssets(dir, input, sourceCommit), /Unsafe/u);
});
