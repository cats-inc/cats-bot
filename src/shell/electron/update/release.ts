import type { BotUpdateState } from '../../../shared/shellUpdate.ts';

export const UPDATE_REPOSITORY = 'cats-inc/cats-bots';
export interface BotRelease {
  schemaVersion: 1;
  repository: typeof UPDATE_REPOSITORY;
  version: string;
  tag: string;
  channel: 'preview';
  signingProfile: 'standard';
  distribution: 'standard-preview';
  platform: 'win32' | 'darwin' | 'linux';
  architectures: string[];
  trust: 'signed' | 'signed-notarized' | 'unsigned-no-certificate' | 'not-applicable';
  sourceCommit: string;
  runtimeCommit: string;
}

export function versionParts(version: unknown): number[] | null {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) return null;
  const parts = version.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function isNewerVersion(candidate: unknown, current: string): candidate is string {
  const next = versionParts(candidate), previous = versionParts(current);
  if (!next || !previous) return false;
  for (let index = 0; index < 3; index++) {
    if (next[index] !== previous[index]) return next[index]! > previous[index]!;
  }
  return false;
}

export function parseBotRelease(value: unknown, version: string, platform: string, arch: string): BotRelease | null {
  if (!value || typeof value !== 'object') return null;
  const release = value as Partial<BotRelease>;
  if (release.schemaVersion !== 1 || release.repository !== UPDATE_REPOSITORY || release.version !== version
    || !versionParts(version) || release.tag !== `v${version}` || release.channel !== 'preview'
    || release.signingProfile !== 'standard' || release.distribution !== 'standard-preview' || release.platform !== platform
    || !['win32', 'darwin', 'linux'].includes(platform)
    || !Array.isArray(release.architectures) || !release.architectures.includes(arch)
    || !release.architectures.every(item => item === 'x64' || item === 'arm64')
    || !/^[a-f0-9]{40}$/u.test(release.sourceCommit ?? '') || !/^[a-f0-9]{40}$/u.test(release.runtimeCommit ?? '')) return null;
  const allowedTrust = platform === 'darwin' ? ['signed-notarized', 'unsigned-no-certificate']
    : platform === 'win32' ? ['signed', 'unsigned-no-certificate'] : ['not-applicable'];
  return allowedTrust.includes(release.trust ?? '') ? release as BotRelease : null;
}

export function initialUpdateState(input: {
  packaged: boolean; version: string; release: BotRelease | null; portable: boolean;
}): BotUpdateState {
  const distribution = !input.packaged ? 'development' : input.release ? 'standard-preview' : 'unofficial';
  const canCheck = distribution === 'standard-preview';
  const unsignedMac = input.release?.platform === 'darwin' && input.release.trust !== 'signed-notarized';
  const canInstall = canCheck && !input.portable && !unsignedMac;
  const reason = !input.packaged ? 'Updates are available in published Cats Bot builds.'
    : !input.release ? 'This build has no valid release identity. Install a published Cats Bot build to enable updates.'
    : input.portable ? 'Portable builds use manual replacement. Open the release page to download the new portable app.'
    : unsignedMac ? 'This macOS build is unsigned. Install updates from the release page; in-app installation requires a signed build.' : null;
  return { phase: canCheck ? 'idle' : 'unavailable', currentVersion: input.version, version: null,
    distribution, canCheck, canInstall, reason, error: null, percent: null };
}

export function releasePage(version: string): string {
  if (!versionParts(version)) throw new Error('Invalid release version.');
  return `https://github.com/${UPDATE_REPOSITORY}/releases/tag/v${version}`;
}
