import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

export const repository = 'cats-inc/cats-bot';
export const platforms = ['windows', 'macos', 'linux'];
export const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const json = async file => JSON.parse(await readFile(file, 'utf8'));
export function releaseVersion(tag) {
  if (typeof tag !== 'string' || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(tag)
    || !tag.slice(1).split('.').map(Number).every(Number.isSafeInteger)) throw new Error('Use an exact vX.Y.Z release tag.');
  return tag.slice(1);
}
export function compareVersions(left, right) {
  const a = releaseVersion(`v${left}`).split('.').map(Number), b = releaseVersion(`v${right}`).split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}
export async function validateInputs(root, tag, publishing = false) {
  const version = releaseVersion(tag);
  const [pkg, lock, runtime] = await Promise.all([json(join(root, 'package.json')), json(join(root, 'package-lock.json')), json(join(root, 'vendor/runtime-source.json'))]);
  if (pkg.version !== version || lock.version !== version || lock.packages?.['']?.version !== version) throw new Error('Tag, package.json and package-lock.json versions must match.');
  if (publishing && compareVersions(version, '0.2.0') < 0) throw new Error('Profile schema 2 requires Bot 0.2.0 or later before publication.');
  if (runtime.schemaVersion !== 1 || runtime.repository !== 'cats-inc/cats-runtime' || !/^[a-f0-9]{40}$/u.test(runtime.commit)
    || !/^vendor\/cats-runtime-[\w.-]+\.tgz$/u.test(runtime.artifact) || !/^[a-f0-9]{64}$/u.test(runtime.sha256)) throw new Error('Invalid immutable Runtime source pin.');
  const dependency = `file:${runtime.artifact}`;
  if (pkg.dependencies?.['@cats-inc/cats-runtime'] !== dependency || lock.packages?.['']?.dependencies?.['@cats-inc/cats-runtime'] !== dependency) throw new Error('Runtime dependency differs from the source pin.');
  const bytes = await readFile(join(root, runtime.artifact));
  const packed = lock.packages?.['node_modules/@cats-inc/cats-runtime'];
  if (digest(bytes) !== runtime.sha256 || packed?.integrity !== `sha512-${digest(bytes, 'sha512', 'base64')}` || packed?.version !== runtime.version
    || packed?.resolved !== dependency) throw new Error('Runtime tarball checksum or lockfile identity mismatch.');
  return { version, tag, runtime };
}
export function signingTrust(platform, env) {
  if (platform === 'windows') {
    if (!env.WIN_CSC_LINK && env.WIN_CSC_KEY_PASSWORD) throw new Error('Windows signing password has no certificate.');
    return env.WIN_CSC_LINK ? 'signed' : 'unsigned-no-certificate';
  }
  if (platform === 'macos') {
    const required = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
    if (required.some(key => env[key]) && !required.every(key => env[key])) throw new Error('macOS signing requires the complete certificate and notarization credentials.');
    return required.every(key => env[key]) ? 'signed-notarized' : 'unsigned-no-certificate';
  }
  if (platform !== 'linux') throw new Error('Unsupported release platform.');
  return 'not-applicable';
}
export function descriptor(input, platform, sourceCommit, trust, candidate = false) {
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit) || !platforms.includes(platform)) throw new Error('Expected immutable source commit and supported platform.');
  return { schemaVersion: 1, repository, version: input.version, tag: input.tag, channel: 'preview', signingProfile: 'standard', distribution: candidate ? 'candidate' : 'standard-preview',
    platform: { windows: 'win32', macos: 'darwin', linux: 'linux' }[platform], architectures: ['x64', 'arm64'],
    trust, sourceCommit, runtimeCommit: input.runtime.commit };
}
export function assertNewerRelease(tag, releases) {
  const version = releaseVersion(tag);
  for (const release of releases.filter(item => !item.draft)) {
    if (/^v\d+\.\d+\.\d+$/u.test(release.tag_name) && compareVersions(version, release.tag_name.slice(1)) <= 0) {
      throw new Error(`The new version must exceed published ${release.tag_name}.`);
    }
  }
}
export function safeAssetName(value) {
  if (typeof value !== 'string') throw new Error('Invalid asset reference.');
  const name = decodeURIComponent(value);
  if (!name || name !== basename(name) || /[\\/\x00-\x1f:?#]/u.test(name) || name === '..' || name.startsWith('.')) throw new Error('Unsafe asset reference.');
  return name;
}
export async function validateAssets(directory, input, sourceCommit, candidate = false) {
  const { parse } = await import('yaml');
  const files = (await readdir(directory)).filter(name => name !== 'SHA256SUMS');
  const prefix = `Cats-Bot-${input.version}-`;
  const expected = [
    `${prefix}setup-x64.exe`, `${prefix}setup-arm64.exe`, `${prefix}portable-x64.exe`, `${prefix}portable-arm64.exe`,
    `${prefix}universal.dmg`, `${prefix}universal.zip`, `${prefix}amd64.deb`, `${prefix}arm64.deb`,
    'latest.yml', 'latest-mac.yml', 'latest-linux.yml', 'latest-linux-arm64.yml',
    `Cats-Bot-${input.tag}-source.zip`, `Cats-Bot-${input.tag}-sources.json`,
    ...platforms.map(platform => `Cats-Bot-${input.tag}-${platform}-build.json`),
  ];
  for (const name of expected) if (!files.includes(name)) throw new Error(`Missing release asset: ${name}`);
  for (const name of files) {
    safeAssetName(name);
    if (!expected.includes(name) && !expected.some(asset => name === `${asset}.blockmap`)) throw new Error(`Unexpected release asset: ${name}`);
    if (!(await stat(join(directory, name))).isFile()) throw new Error(`Not a release file: ${name}`);
  }
  const covered = new Set();
  for (const name of expected.filter(file => file.endsWith('.yml'))) {
    const metadata = parse(await readFile(join(directory, name), 'utf8'));
    if (metadata.version !== input.version || !Array.isArray(metadata.files) || metadata.files.length === 0) throw new Error(`Invalid update metadata: ${name}`);
    const allowed = name === 'latest.yml' ? [`${prefix}setup-x64.exe`, `${prefix}setup-arm64.exe`]
      : name === 'latest-mac.yml' ? [`${prefix}universal.zip`, `${prefix}universal.dmg`]
      : [name === 'latest-linux.yml' ? `${prefix}amd64.deb` : `${prefix}arm64.deb`];
    for (const item of metadata.files) {
      const asset = safeAssetName(item.url);
      if (!allowed.includes(asset)) throw new Error(`Wrong platform asset in ${name}: ${asset}`);
      const bytes = await readFile(join(directory, asset));
      if (item.sha512 !== digest(bytes, 'sha512', 'base64') || item.size !== bytes.length) throw new Error(`Update checksum/size mismatch: ${asset}`);
      covered.add(asset);
    }
    const legacy = metadata.files.find(item => safeAssetName(item.url) === safeAssetName(metadata.path));
    if (!legacy || legacy.sha512 !== metadata.sha512) throw new Error(`Legacy update reference mismatch: ${name}`);
  }
  for (const asset of expected.filter(name => /setup-.*\.exe$|universal\.zip$|\.deb$/u.test(name))) {
    if (!covered.has(asset)) throw new Error(`Updater metadata omits ${asset}`);
  }
  for (const platform of platforms) {
    const receipt = await json(join(directory, `Cats-Bot-${input.tag}-${platform}-build.json`));
    const allowedTrust = platform === 'windows' ? ['signed', 'unsigned-no-certificate'] : platform === 'macos' ? ['signed-notarized', 'unsigned-no-certificate'] : ['not-applicable'];
    if (!allowedTrust.includes(receipt.trust) || JSON.stringify(receipt) !== JSON.stringify(descriptor(input, platform, sourceCommit, receipt.trust, candidate))) throw new Error(`Packaged identity mismatch: ${platform}`);
  }
  const sources = await json(join(directory, `Cats-Bot-${input.tag}-sources.json`));
  if (sources.sourceCommit !== sourceCommit || sources.runtimeCommit !== input.runtime.commit || sources.runtimeSha256 !== input.runtime.sha256
    || sources.archiveSha256 !== digest(await readFile(join(directory, `Cats-Bot-${input.tag}-source.zip`)))) throw new Error('Complete-source identity mismatch.');
  const sums = await Promise.all(files.sort().map(async name => `${digest(await readFile(join(directory, name)))}  ${name}`));
  await writeFile(join(directory, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  return expected;
}
