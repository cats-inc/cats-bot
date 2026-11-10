// SPEC-003 FR-10: macOS packages carry the dictation helper (native/macos-stt, on-device
// speech recognition), built universal so the universal app merges it as one binary, at
// Resources/native/macos-stt/cats-stt-macos. package.json build.mac.extraResources maps
// build/native-macos/macos-stt there. Ported from Cats Desktop's buildMacosVoiceHelper
// (scripts/build-desktop-installer.mjs at cats-platform 6a2a1b02).
// Usage: node scripts/macos-voice-helper.mjs build [--arch arm64|x86_64 | --host]
//        node scripts/macos-voice-helper.mjs verify RESOURCES_DIR [--arch arm64|x86_64]...
// Without --arch the helper is universal (arm64 and x86_64). Off macOS both do nothing.
import { spawnSync } from 'node:child_process';
import { access, chmod, copyFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HELPER_NAME = 'cats-stt-macos';
export const PACKAGED_HELPER = join('native', 'macos-stt', HELPER_NAME);
export const MAC_ARCHES = ['arm64', 'x86_64'];

export const helperOutput = (root) => join(root, 'build', 'native-macos', 'macos-stt', HELPER_NAME);

export function buildArguments(root, arches = MAC_ARCHES) {
  return ['build', '-c', 'release', '--package-path', join(root, 'native', 'macos-stt'), ...arches.flatMap((arch) => ['--arch', arch])];
}

function checkArches(arches) {
  if (!Array.isArray(arches) || arches.length === 0 || arches.some((arch) => !MAC_ARCHES.includes(arch))) {
    throw new Error(`macOS helper architectures must be among ${MAC_ARCHES.join(', ')}; got ${JSON.stringify(arches)}.`);
  }
  return [...new Set(arches)];
}

function runSwift(args, cwd) {
  const result = spawnSync('swift', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.error?.code === 'ENOENT') throw new Error('macOS packages need Swift (Xcode) to build the dictation helper.');
  if (result.error || result.status !== 0) throw result.error ?? new Error(`swift ${args[0]} exited ${result.status}`);
  return result.stdout;
}

/**
 * A Mach-O file's architectures, from `lipo -archs`. Not `-verify_arch`: newer lipo (Command Line
 * Tools on macOS 27) takes only one architecture after it and reads the rest as input files.
 */
export function macArchitectures(file) {
  const result = spawnSync('lipo', ['-archs', file], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`lipo could not read ${file}`);
  return result.stdout.trim().split(/\s+/u);
}

/** Throws unless `file` has every required architecture; returns the ones it has. */
export function requireMacArchitectures(file, required, { lipo = macArchitectures, what = file } = {}) {
  const present = lipo(file);
  const missing = required.filter((arch) => !present.includes(arch));
  if (missing.length > 0) throw new Error(`${what} lacks ${missing.join(', ')} (has ${present.join(', ')})`);
  return present;
}

/** Builds the helper and stages it; the staging directory is cleared first, so no stale helper is packaged. */
export async function buildMacosVoiceHelper(root, arches = MAC_ARCHES, { run = runSwift } = {}) {
  const selected = checkArches(arches);
  const args = buildArguments(root, selected);
  run(args, root);
  const binPath = run([...args, '--show-bin-path'], root).trim().split('\n').at(-1);
  const output = helperOutput(root);
  await rm(join(output, '..'), { recursive: true, force: true });
  await mkdir(join(output, '..'), { recursive: true });
  await copyFile(join(binPath, HELPER_NAME), output);
  await chmod(output, 0o755);
  return { output, arches: selected };
}

/** A packaged macOS app's resources must carry the helper with every architecture the app has. */
export async function verifyPackagedMacosVoiceHelper(resourcesDir, arches = MAC_ARCHES, { lipo = macArchitectures } = {}) {
  const helper = join(resourcesDir, PACKAGED_HELPER);
  try {
    await access(helper);
  } catch {
    throw new Error(`The macOS package lacks the dictation helper at ${helper}`);
  }
  return { arches: requireMacArchitectures(helper, checkArches(arches), { lipo, what: 'The macOS dictation helper' }) };
}

/** CLI entry; returns what it did so tests can check the other platforms. */
export async function main(argv, { platform = process.platform, root = process.cwd(), log = console.log, ...options } = {}) {
  const [command, ...rest] = argv;
  if (command !== 'build' && command !== 'verify') {
    throw new Error('Usage: node scripts/macos-voice-helper.mjs build|verify [RESOURCES_DIR] [--arch arm64|x86_64]...');
  }
  if (platform !== 'darwin') {
    log(`Skipping the macOS dictation helper (${command}) on ${platform}.`);
    return { skipped: true };
  }
  const arches = rest.flatMap((value, index) => (rest[index - 1] === '--arch' ? [value] : []));
  // --host: the architecture electron-builder --dir packages on this Mac.
  const host = rest.includes('--host') ? [process.arch === 'arm64' ? 'arm64' : 'x86_64'] : [];
  const selected = arches.length > 0 ? arches : host.length > 0 ? host : MAC_ARCHES;
  if (command === 'build') {
    const built = await buildMacosVoiceHelper(root, selected, options);
    log(`Built ${HELPER_NAME} for ${built.arches.join(', ')}`);
    return { built };
  }
  const resources = rest.find((value, index) => !value.startsWith('--') && rest[index - 1] !== '--arch');
  // verify --host: the --dir package built for this Mac.
  if (!resources) throw new Error('verify needs the packaged app\'s Resources directory.');
  const verified = await verifyPackagedMacosVoiceHelper(resolve(resources), selected, options);
  log(`Verified the packaged dictation helper (${verified.arches.join(', ')})`);
  return { verified };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
