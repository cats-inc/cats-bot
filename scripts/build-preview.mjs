// Build an identified Standard Preview locally or in CI. Never publishes.
// Usage: node scripts/build-preview.mjs --platform windows|macos|linux --tag vX.Y.Z --source FULL_SHA [--dir] [--release]
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { descriptor, repository, signingTrust, validateInputs, workflowName } from './release-contract.mjs';
import { buildMacosVoiceHelper, requireMacArchitectures, verifyPackagedMacosVoiceHelper } from './macos-voice-helper.mjs';
import { publishWindowsDesktopControl, publishWindowsDictation, verifyPackagedWindowsDesktopControl, verifyPackagedWindowsDictation } from './windows-desktop-control.mjs';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const value = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
const platform = value('--platform'), tag = value('--tag'), source = value('--source');
const root = process.cwd();
const input = await validateInputs(root, tag);
const publishingBuild = args.includes('--release');
if (publishingBuild) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (process.env.GITHUB_REPOSITORY !== repository || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || process.env.GITHUB_WORKFLOW !== workflowName || process.env.GITHUB_SHA !== source
    || head.status !== 0 || head.stdout.trim() !== source) throw new Error('Release identity is reserved for the pinned manual publication workflow.');
}
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const trust = signingTrust(platform, process.env);
const release = descriptor(input, platform, source, trust, !publishingBuild);
const stage = join(root, 'dist', 'release');
await mkdir(stage, { recursive: true });
await writeFile(join(stage, 'bot-release.json'), `${JSON.stringify(release, null, 2)}\n`);
const config = {
  ...pkg.build,
  extraResources: [{ from: join(stage, 'bot-release.json'), to: 'bot-release.json' }],
  publish: [{ provider: 'github', owner: repository.split('/')[0], repo: repository.split('/')[1], releaseType: 'prerelease' }],
  mac: { ...pkg.build.mac, identity: trust === 'signed-notarized' ? undefined : null, hardenedRuntime: trust === 'signed-notarized', notarize: trust === 'signed-notarized' },
};
await writeFile(join(stage, 'builder.json'), JSON.stringify(config));
const flag = { windows: '--win', macos: '--mac', linux: '--linux' }[platform];
// SPEC-006 BDC-11: Windows packages carry the desktop control helper for each architecture they build.
if (platform === 'windows') {
  if (process.platform !== 'win32') throw new Error('Windows packages are built on Windows: the desktop control helper needs dotnet publish.');
  for (const helper of await publishWindowsDesktopControl(root, args.includes('--dir') ? ['x64'] : ['x64', 'arm64'])) {
    console.log(`Published the desktop control helper for ${helper.arch} with ${helper.runtime.id} ${helper.runtime.version} notices`);
  }
  // SPEC-003 FR-10: the dictation helper beside it.
  for (const helper of await publishWindowsDictation(root, args.includes('--dir') ? ['x64'] : ['x64', 'arm64'])) {
    console.log(`Published the dictation helper for ${helper.arch}`);
  }
}
// SPEC-003 FR-10: macOS packages carry the dictation helper, universal like the app (x64 for --dir).
if (platform === 'macos') {
  const helper = await buildMacosVoiceHelper(root, args.includes('--dir') ? ['x86_64'] : ['arm64', 'x86_64']);
  console.log(`Built the dictation helper for ${helper.arches.join(', ')}`);
}
const buildArgs = [require.resolve('electron-builder/out/cli/cli.js'), '--config', join(stage, 'builder.json'), flag,
  ...(args.includes('--dir') ? ['--dir', '--x64'] : platform === 'macos' ? ['--universal'] : ['--x64', '--arm64']), '--publish', 'never'];
const built = spawnSync(process.execPath, buildArgs, { cwd: root, stdio: 'inherit', env: { ...process.env,
  CSC_IDENTITY_AUTO_DISCOVERY: trust === 'signed-notarized' ? 'true' : 'false' } });
if (built.error || built.status !== 0) throw built.error ?? new Error(`Package build exited ${built.status}`);
// Read back identities from every packaged architecture, not just the staged input.
const directories = await readdir(join(root, 'release'), { withFileTypes: true });
const packaged = directories.filter(item => item.isDirectory() && (platform === 'windows' ? /^win(?:-arm64)?-unpacked$/u.test(item.name)
  : platform === 'macos' ? /^mac(?:-universal)?$/u.test(item.name) : /^linux(?:-arm64)?-unpacked$/u.test(item.name)));
if (packaged.length !== (args.includes('--dir') || platform === 'macos' ? 1 : 2)) throw new Error('Packaged architecture count mismatch.');
for (const directory of packaged) {
  const resources = platform === 'macos' ? join(root, 'release', directory.name, 'Cats Bot.app', 'Contents', 'Resources') : join(root, 'release', directory.name, 'resources');
  if (platform === 'macos') {
    // Verify here so unsigned candidate CI exercises the same native check.
    const architectures = requireMacArchitectures(join(resources, '..', 'MacOS', 'Cats Bot'),
      args.includes('--dir') ? ['x86_64'] : ['x86_64', 'arm64'], { what: 'The packaged macOS app' });
    console.log(`Verified the packaged macOS app (${architectures.join(', ')})`);
  }
  const actual = JSON.parse(await readFile(join(resources, 'bot-release.json'), 'utf8'));
  if (JSON.stringify(actual) !== JSON.stringify(release)) throw new Error('Packaged descriptor differs from the release identity.');
  const runtime = JSON.parse(await readFile(join(resources, 'app', 'node_modules', '@cats-inc', 'cats-runtime', 'package.json'), 'utf8'));
  if (runtime.version !== input.runtime.version) throw new Error('Packaged Runtime version differs from the pin.');
  if (platform === 'windows') console.log(`Verified the ${(await verifyPackagedWindowsDesktopControl(resources)).arch} desktop control helper in ${directory.name}`);
  if (platform === 'windows') console.log(`Verified the ${(await verifyPackagedWindowsDictation(resources)).arch} dictation helper in ${directory.name}`);
  if (platform === 'macos') {
    const helper = await verifyPackagedMacosVoiceHelper(resources, args.includes('--dir') ? ['x86_64'] : ['arm64', 'x86_64']);
    console.log(`Verified the dictation helper (${helper.arches.join(', ')}) in ${directory.name}`);
  }
}
await writeFile(resolve('release', `Cats-Bot-${tag}-${platform}-build.json`), `${JSON.stringify(release, null, 2)}\n`);
