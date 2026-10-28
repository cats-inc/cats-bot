// SPEC-006 BDC-11: Windows packages carry the desktop control helper, published
// self-contained per architecture, at resources/native/windows-desktop-control/.
// package.json build.win.extraResources maps build/native-windows/${arch}/windows-desktop-control
// there. electron-builder only warns when that source is missing, and an x64 helper
// still starts on Windows on Arm under emulation, so packages are read back instead.
// Usage: node scripts/windows-desktop-control.mjs publish [--arch x64|arm64]...
//        node scripts/windows-desktop-control.mjs verify [--arch x64|arm64]...
// Without --arch both follow the host architecture, as electron-builder does. Off
// Windows both do nothing: macOS and Linux packages never need dotnet.
import { spawnSync } from 'node:child_process';
import { access, mkdir, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageDotnetRuntimeNotices, verifyDotnetRuntimeNotices } from './dotnet-runtime-notices.mjs';

export const HELPER_DIRECTORY = 'windows-desktop-control';
export const HELPER_PROJECT = 'CatsDesktopControlWindows.csproj';
export const HELPER_NAME = 'cats-desktop-control-windows';
export const HELPER_BINARY = `${HELPER_NAME}.exe`;
export const PACKAGED_HELPER_DIRECTORY = `native/${HELPER_DIRECTORY}`;
export const WINDOWS_APP_EXECUTABLE = 'Cats Bot.exe';
export const WINDOWS_ARCHES = ['x64', 'arm64'];

const PE_MACHINES = { 0x8664: 'x64', 0xaa64: 'arm64', 0x014c: 'ia32' };

export const nativeBuildRoot = (root) => join(root, 'build', 'native-windows');
export const helperOutputDirectory = (root, arch) => join(nativeBuildRoot(root), arch, HELPER_DIRECTORY);
/** electron-builder names the x64 directory win-unpacked and others win-<arch>-unpacked. */
export const unpackedResources = (root, arch) =>
  join(root, 'release', arch === 'x64' ? 'win-unpacked' : `win-${arch}-unpacked`, 'resources');

function checkArches(arches) {
  if (!Array.isArray(arches) || arches.length === 0 || arches.some((arch) => !WINDOWS_ARCHES.includes(arch))) {
    throw new Error(`Windows helper architectures must be among ${WINDOWS_ARCHES.join(', ')}; got ${JSON.stringify(arches)}.`);
  }
  return [...new Set(arches)];
}

export function publishArguments(root, arch) {
  return ['publish', join(root, 'native', HELPER_DIRECTORY, HELPER_PROJECT), '-c', 'Release', '-r', `win-${arch}`,
    '--self-contained', 'true', '-o', helperOutputDirectory(root, arch)];
}

function runDotnet(args, cwd) {
  const result = spawnSync('dotnet', args, { cwd, stdio: 'inherit' });
  if (result.error?.code === 'ENOENT') {
    throw new Error('Windows packages need the .NET 8 SDK or newer (dotnet) to publish the desktop control helper.');
  }
  if (result.error || result.status !== 0) throw result.error ?? new Error(`dotnet publish exited ${result.status}`);
}

/**
 * Publish the helper for each architecture into its own directory, then stage the
 * .NET runtime's license texts beside it. The build root is cleared first, so a
 * helper from an earlier build of another architecture can never be packaged.
 */
export async function publishWindowsDesktopControl(root, arches, { run = runDotnet, nugetRoot } = {}) {
  const selected = checkArches(arches);
  await rm(nativeBuildRoot(root), { recursive: true, force: true });
  const published = [];
  for (const arch of selected) {
    const outputDir = helperOutputDirectory(root, arch);
    await mkdir(outputDir, { recursive: true });
    await run(publishArguments(root, arch), root);
    const notices = await stageDotnetRuntimeNotices({
      outputDir,
      depsJsonPath: join(outputDir, `${HELPER_NAME}.deps.json`),
      helperName: HELPER_BINARY,
      ...(nugetRoot ? { nugetRoot } : {}),
    });
    published.push({ arch, outputDir, runtime: notices.runtime });
  }
  return published;
}

/** The architecture recorded in a PE file's COFF header. */
export async function readPeArchitecture(file) {
  const handle = await open(file, 'r');
  try {
    const dos = Buffer.alloc(64);
    await handle.read(dos, 0, dos.length, 0);
    if (dos.toString('latin1', 0, 2) !== 'MZ') throw new Error(`${file} is not a PE executable`);
    const header = Buffer.alloc(6);
    await handle.read(header, 0, header.length, dos.readUInt32LE(0x3c));
    if (header.toString('latin1', 0, 4) !== 'PE\0\0') throw new Error(`${file} has no PE header`);
    const machine = header.readUInt16LE(4);
    return PE_MACHINES[machine] ?? `0x${machine.toString(16)}`;
  } finally {
    await handle.close();
  }
}

/**
 * A packaged Windows app's resources must carry the helper built for the app's own
 * architecture, with the .NET runtime's license texts beside it.
 */
export async function verifyPackagedWindowsDesktopControl(resourcesDir) {
  const helperDir = join(resourcesDir, PACKAGED_HELPER_DIRECTORY);
  const helper = join(helperDir, HELPER_BINARY);
  try {
    await access(helper);
  } catch {
    throw new Error(`The Windows package lacks the desktop control helper at ${helper}`);
  }
  const [appArch, helperArch] = await Promise.all([
    readPeArchitecture(join(resourcesDir, '..', WINDOWS_APP_EXECUTABLE)),
    readPeArchitecture(helper),
  ]);
  if (helperArch !== appArch) throw new Error(`The Windows desktop control helper is ${helperArch} but the app is ${appArch}`);
  await verifyDotnetRuntimeNotices(helperDir);
  return { arch: appArch };
}

function hostArches() {
  if (!WINDOWS_ARCHES.includes(process.arch)) throw new Error(`Unsupported Windows host architecture ${process.arch}; pass --arch.`);
  return [process.arch];
}

/** CLI entry; returns what it did so tests can check the non-Windows path. */
export async function main(argv, { platform = process.platform, root = process.cwd(), log = console.log, ...options } = {}) {
  const [command, ...rest] = argv;
  if (command !== 'publish' && command !== 'verify') {
    throw new Error('Usage: node scripts/windows-desktop-control.mjs publish|verify [--arch x64|arm64]...');
  }
  if (platform !== 'win32') {
    log(`Skipping the Windows desktop control helper (${command}) on ${platform}.`);
    return { skipped: true };
  }
  const arches = rest.flatMap((value, index) => (rest[index - 1] === '--arch' ? [value] : []));
  const selected = checkArches(arches.length > 0 ? arches : hostArches());
  if (command === 'publish') {
    const published = await publishWindowsDesktopControl(root, selected, options);
    for (const item of published) {
      log(`Published ${HELPER_BINARY} for ${item.arch} with ${item.runtime.id} ${item.runtime.version} notices`);
    }
    return { published };
  }
  const verified = [];
  for (const arch of selected) {
    verified.push(await verifyPackagedWindowsDesktopControl(unpackedResources(root, arch)));
    log(`Verified the packaged ${arch} desktop control helper and its notices`);
  }
  return { verified };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
