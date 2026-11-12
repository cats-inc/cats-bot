/** Adapted from cats-platform desktop/host/versionedGithubProvider.ts at 71e5c2089368e8914d12ede13c881d78237915a0 (MIT). */
import {
  CancellationToken,
  HttpError,
  newError,
  parseXml,
  type CustomPublishOptions,
  type UpdateInfo,
} from 'builder-util-runtime';
import type { AppUpdater } from 'electron-updater';
import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider.js';
import {
  parseUpdateInfo,
  type ProviderRuntimeOptions,
} from 'electron-updater/out/providers/Provider.js';

interface Candidate {
  tag: string;
  version: string;
  parts: number[];
  title: string;
}

/** Public Atom feeds also contain bare Git tags, including development milestones. */
export class VersionedGithubProvider extends GitHubProvider {
  private readonly feedUrl: URL;
  private readonly releasesUrl: URL;
  private readonly updatePlatform: string;

  constructor(
    options: CustomPublishOptions,
    updater: AppUpdater,
    runtimeOptions: ProviderRuntimeOptions,
  ) {
    if (
      typeof options.owner !== 'string' ||
      typeof options.repo !== 'string' ||
      !/^[A-Za-z0-9_.-]+$/u.test(options.owner) ||
      !/^[A-Za-z0-9_.-]+$/u.test(options.repo)
    ) {
      throw newError('Invalid update repository.', 'ERR_UPDATER_INVALID_PROVIDER_CONFIGURATION');
    }
    super(
      { provider: 'github', owner: options.owner, repo: options.repo },
      updater,
      runtimeOptions,
    );
    this.releasesUrl = new URL(`https://github.com/${options.owner}/${options.repo}/releases/`);
    this.feedUrl = new URL(this.releasesUrl.href.slice(0, -1) + '.atom');
    this.updatePlatform = runtimeOptions.platform;
  }

  override async getLatestVersion(): ReturnType<GitHubProvider['getLatestVersion']> {
    const cancellation = new CancellationToken();
    const xml = await this.httpRequest(
      this.feedUrl,
      { accept: 'application/atom+xml' },
      cancellation,
    );
    if (!xml)
      throw newError('Update information is unavailable.', 'ERR_UPDATER_INVALID_RELEASE_FEED');
    let candidates: Candidate[];
    try {
      candidates = parseXml(xml)
        .getElements('entry')
        .flatMap((entry) => {
          const href = entry.elementOrNull('link')?.attributes?.href;
          if (!href) return [];
          const prefix = this.releasesUrl.href + 'tag/';
          if (!href.startsWith(prefix)) return [];
          const tag = href.slice(prefix.length);
          if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(tag)) return [];
          const version = tag.slice(1);
          const parts = version.split('.').map(Number);
          return parts.every(Number.isSafeInteger)
            ? [{ tag, version, parts, title: entry.elementValueOrEmpty('title') }]
            : [];
        });
    } catch {
      throw newError('Update information could not be read.', 'ERR_UPDATER_INVALID_RELEASE_FEED');
    }
    candidates.sort(
      (a, b) => b.parts[0]! - a.parts[0]! || b.parts[1]! - a.parts[1]! || b.parts[2]! - a.parts[2]!,
    );
    const channelFile = this.getDefaultChannelName() + '.yml';
    let invalidMetadata = false;
    for (const candidate of candidates) {
      const url = new URL(`download/${candidate.tag}/${channelFile}`, this.releasesUrl);
      let raw: string | null;
      try {
        raw = await this.httpRequest(url, null, cancellation);
      } catch (error) {
        // A plain version tag may also have no release. Only 404 permits trying
        // another candidate; network/auth/service failures must remain errors.
        if (error instanceof HttpError && error.statusCode === 404) continue;
        throw error;
      }
      let info: UpdateInfo;
      try {
        info = parseUpdateInfo(raw, channelFile, url);
      } catch {
        invalidMetadata = true;
        continue;
      }
      if (!hasUpdateFiles(info, candidate.version, this.updatePlatform)) {
        invalidMetadata = true;
        continue;
      }
      // Inherited resolveFiles keeps downloads and differential-update paths on
      // this exact tag. Native checksum/signature/install validation is unchanged.
      return { ...info, tag: candidate.tag, releaseName: info.releaseName ?? candidate.title };
    }
    throw newError(
      'No versioned release has valid update information for this platform.',
      invalidMetadata ? 'ERR_UPDATER_INVALID_UPDATE_INFO' : 'ERR_UPDATER_NO_PUBLISHED_VERSIONS',
    );
  }
}

function hasUpdateFiles(info: UpdateInfo, version: string, platform: string): boolean {
  if (
    !info ||
    typeof info !== 'object' ||
    info.version !== version ||
    !Array.isArray(info.files) ||
    info.files.length === 0
  )
    return false;
  const names = new Set<string>();
  for (const file of info.files) {
    if (
      !file ||
      typeof file.url !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(file.url) ||
      !file.url.includes(`-${version}-`) ||
      names.has(file.url) ||
      typeof file.sha512 !== 'string' ||
      !/^[A-Za-z0-9+/]{86}==$/u.test(file.sha512) ||
      typeof file.size !== 'number' ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0
    )
      return false;
    names.add(file.url);
  }
  const arch = process.env.TEST_UPDATER_ARCH || process.arch;
  const suffixes =
    platform === 'darwin'
      ? ['-universal.zip', `-${arch}.zip`]
      : platform === 'win32'
        ? [`-setup-${arch}.exe`]
        : [`-${arch === 'x64' ? 'amd64' : arch}.deb`];
  return info.files.some((file) => suffixes.some((suffix) => file.url.endsWith(suffix)));
}
