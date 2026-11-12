import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError } from 'builder-util-runtime';
import type { AppUpdater } from 'electron-updater';
import { createClient } from 'electron-updater/out/providerFactory.js';
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider.js';
import { VersionedGithubProvider } from '../../src/shell/electron/update/versionedGithubProvider.ts';

const repository = 'cats-inc/cats-bot';
const hash = Buffer.alloc(64, 1).toString('base64');
const metadata = (version: string, patch: Record<string, unknown> = {}, suffix = 'universal.zip') =>
  JSON.stringify({
    version,
    files: [{ url: `Cats-${version}-${suffix}`, sha512: hash, size: 123 }],
    ...patch,
  });
const feed = (tags: string[]) =>
  `<feed>${tags.map((tag) => `<entry><link href="https://github.com/${repository}/releases/tag/${tag}"/><title>${tag}</title></entry>`).join('')}</feed>`;

function harness(
  tags: string[],
  responses: Record<string, string | Error>,
  platform: ProviderRuntimeOptions['platform'] = 'darwin',
) {
  const requests: string[] = [];
  const suffix =
    platform === 'darwin'
      ? '-mac'
      : platform === 'linux'
        ? '-linux' + (process.arch === 'x64' ? '' : `-${process.arch}`)
        : '';
  // Deliberately partial native collaborators: only HTTP is exercised, never Electron.
  const executor = {
    async request(options: { path: string }) {
      requests.push(options.path);
      if (options.path.endsWith('.atom')) return feed(tags);
      assert.ok(options.path.endsWith(`/latest${suffix}.yml`));
      const tag = options.path.split('/').at(-2)!;
      const response = responses[tag] ?? new HttpError(404);
      if (response instanceof Error) throw response;
      return response;
    },
  } as unknown as ProviderRuntimeOptions['executor'];
  const provider = createClient(
    {
      provider: 'custom',
      owner: 'cats-inc',
      repo: 'cats-bot',
      updateProvider: VersionedGithubProvider,
    },
    {} as AppUpdater,
    { executor, platform, isUseMultipleRangeRequest: false },
  );
  return { provider, requests };
}

test('real provider factory ignores a milestone before the current published version', async () => {
  const { provider, requests } = harness(['state-db-p1', 'v0.5.9'], {
    'v0.5.9': metadata('0.5.9'),
  });
  const info = await provider.getLatestVersion();
  assert.equal(info.version, '0.5.9');
  assert.equal(info.tag, 'v0.5.9');
  assert.equal(requests.length, 2);
  assert.ok(requests.every((path) => !path.includes('state-db-p1')));
  assert.equal(
    provider.resolveFiles(info)[0]!.url.href,
    `https://github.com/${repository}/releases/download/v0.5.9/Cats-0.5.9-universal.zip`,
  );
});

test('version ordering wins over feed order, including multi-digit components', async () => {
  const { provider, requests } = harness(
    ['v0.5.9', 'v0.5.10', 'v0.6.0', 'v01.0.0', 'v999999999999999999999.0.0', 'v0.7.0-beta.1'],
    {
      'v0.5.9': metadata('0.5.9'),
      'v0.5.10': metadata('0.5.10'),
      'v0.6.0': metadata('0.6.0'),
    },
  );
  assert.equal((await provider.getLatestVersion()).version, '0.6.0');
  assert.equal(requests.length, 2);
});

test('a plain version tag without updater metadata falls back to a published version', async () => {
  const { provider, requests } = harness(['v0.5.10', 'v0.5.9'], { 'v0.5.9': metadata('0.5.9') });
  assert.equal((await provider.getLatestVersion()).tag, 'v0.5.9');
  assert.equal(requests.length, 3);
});

const invalidMetadata: Record<string, string> = {
  'version mismatch': metadata('0.5.9'),
  'missing files': metadata('0.5.10', { files: [] }),
  'missing checksum': metadata('0.5.10', {
    files: [{ url: 'Cats-0.5.10-universal.zip', size: 123 }],
  }),
  'bad checksum': metadata('0.5.10', {
    files: [{ url: 'Cats-0.5.10-universal.zip', sha512: 'bad', size: 123 }],
  }),
  'missing size': metadata('0.5.10', {
    files: [{ url: 'Cats-0.5.10-universal.zip', sha512: hash }],
  }),
  'unsafe path': metadata('0.5.10', {
    files: [{ url: '../Cats-0.5.10-universal.zip', sha512: hash, size: 123 }],
  }),
  'external URL': metadata('0.5.10', {
    files: [{ url: 'https://example.com/Cats-0.5.10-universal.zip', sha512: hash, size: 123 }],
  }),
  'wrong artifact version': metadata('0.5.10', {
    files: [{ url: 'Cats-0.5.8-universal.zip', sha512: hash, size: 123 }],
  }),
  'no macOS updater ZIP': metadata('0.5.10', {}, 'universal.dmg'),
  'invalid YAML': ': [unclosed',
  'null YAML': 'null',
};
for (const [reason, invalid] of Object.entries(invalidMetadata)) {
  test(`skips a candidate with ${reason}`, async () => {
    const { provider } = harness(['v0.5.10', 'v0.5.9'], {
      'v0.5.10': invalid,
      'v0.5.9': metadata('0.5.9'),
    });
    assert.equal((await provider.getLatestVersion()).tag, 'v0.5.9');
  });
}

for (const error of [
  new HttpError(403),
  new HttpError(500),
  Object.assign(new Error('network timeout'), { code: 'ETIMEDOUT' }),
]) {
  test(`does not hide ${'code' in error ? error.code : error.statusCode} by selecting an older version`, async () => {
    const { provider, requests } = harness(['v0.5.10', 'v0.5.9'], {
      'v0.5.10': error,
      'v0.5.9': metadata('0.5.9'),
    });
    await assert.rejects(provider.getLatestVersion(), (candidate) => candidate === error);
    assert.equal(requests.length, 2);
  });
}

test('no valid release is an explicit error, never a false up-to-date result', async () => {
  for (const tags of [[], ['state-db-p1'], ['v0.5.10']]) {
    const { provider } = harness(tags, {});
    await assert.rejects(provider.getLatestVersion(), {
      code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS',
    });
  }
  const { provider } = harness(['v0.5.10'], { 'v0.5.10': 'null' });
  await assert.rejects(provider.getLatestVersion(), { code: 'ERR_UPDATER_INVALID_UPDATE_INFO' });
});

for (const platform of ['darwin', 'win32', 'linux'] as const) {
  test(`uses ${platform}'s own metadata and installer format`, async () => {
    const arch = process.env.TEST_UPDATER_ARCH || process.arch;
    const suffix =
      platform === 'darwin'
        ? 'universal.zip'
        : platform === 'win32'
          ? `setup-${arch}.exe`
          : `${arch === 'x64' ? 'amd64' : arch}.deb`;
    const { provider } = harness(
      ['state-db-p1', 'v0.5.9'],
      { 'v0.5.9': metadata('0.5.9', {}, suffix) },
      platform,
    );
    assert.equal((await provider.getLatestVersion()).version, '0.5.9');
  });
}

test('rejects wrong-architecture or portable-only packages for all platforms', async () => {
  const arch = process.env.TEST_UPDATER_ARCH || process.arch;
  const other = arch === 'x64' ? 'arm64' : 'x64';
  for (const [platform, suffix] of [
    ['darwin', `${other}.zip`],
    ['win32', `setup-${other}.exe`],
    ['win32', `portable-${arch}.exe`],
    ['linux', `${other === 'x64' ? 'amd64' : other}.deb`],
  ] as const) {
    const { provider } = harness(['v0.5.9'], { 'v0.5.9': metadata('0.5.9', {}, suffix) }, platform);
    await assert.rejects(provider.getLatestVersion(), { code: 'ERR_UPDATER_INVALID_UPDATE_INFO' });
  }
});
