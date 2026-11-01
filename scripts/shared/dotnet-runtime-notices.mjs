// The Windows voice helper ships a self-contained .NET runtime. `dotnet publish`
// copies the runtime binaries but not the runtime pack's LICENSE.TXT and
// THIRD-PARTY-NOTICES.TXT, so stage them from the NuGet cache using the exact pack
// version the published deps.json names. Packaging fails closed when the texts are
// missing rather than shipping Microsoft code without its notices.
import assert from 'node:assert/strict';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const RUNTIME_PACK_PREFIX = 'runtimepack.';
const DOTNET_RUNTIME_PACK = /^Microsoft\.NETCore\.App\.Runtime\./;
const WINDOWS_SDK_PACK = 'Microsoft.Windows.SDK.NET.Ref';
export const WINDOWS_SDK_LICENSE_URL = 'https://aka.ms/WinSDKLicenseURL';
export const DOTNET_NOTICE_FILES = ['LICENSE.TXT', 'THIRD-PARTY-NOTICES.TXT'];
export const NOTICES_DIRECTORY = 'licenses';
export const DOTNET_NOTICES_DIRECTORY = 'dotnet-runtime';
export const NOTICES_README = 'README.txt';

/** Runtime packs a self-contained deps.json lists, as `{ id, version }`. */
export function resolveRuntimePacks(depsJson) {
  const packs = [];
  for (const target of Object.values(depsJson?.targets ?? {})) {
    for (const key of Object.keys(target ?? {})) {
      if (!key.startsWith(RUNTIME_PACK_PREFIX)) continue;
      const [id, version] = key.slice(RUNTIME_PACK_PREFIX.length).split('/');
      if (id && version && !packs.some((pack) => pack.id === id && pack.version === version)) {
        packs.push({ id, version });
      }
    }
  }
  return packs;
}

export function classifyRuntimePacks(packs) {
  const runtime = packs.find((pack) => DOTNET_RUNTIME_PACK.test(pack.id));
  if (!runtime) {
    throw new Error('deps.json names no Microsoft.NETCore.App.Runtime pack; the helper is not self-contained');
  }
  return { runtime, windowsSdk: packs.find((pack) => pack.id === WINDOWS_SDK_PACK) ?? null };
}

export function nugetPackagesRoot(env = process.env, home = homedir()) {
  return env.NUGET_PACKAGES || join(home, '.nuget', 'packages');
}

export function renderNoticesReadme({ helperName, runtime, windowsSdk,
  applicationNotice = 'The Cats application itself is licensed separately; see LICENSE next to the application.' }) {
  const lines = [
    `Third-party components bundled with ${helperName}`,
    '',
    `1. .NET runtime: ${runtime.id} ${runtime.version}`,
    '   (c) .NET Foundation and Contributors. Licensed under the MIT License.',
    `   License text: ${DOTNET_NOTICES_DIRECTORY}/LICENSE.TXT`,
    `   Third-party notices: ${DOTNET_NOTICES_DIRECTORY}/THIRD-PARTY-NOTICES.TXT`,
    '   Source: https://github.com/dotnet/runtime',
    '',
  ];
  if (windowsSdk) {
    lines.push(
      `2. Windows SDK .NET projections: ${windowsSdk.id} ${windowsSdk.version}`,
      '   Files: Microsoft.Windows.SDK.NET.dll, WinRT.Runtime.dll',
      '   (c) Microsoft Corporation. All rights reserved.',
      `   License: Microsoft Software License Terms for the Windows SDK, ${WINDOWS_SDK_LICENSE_URL}`,
      '   Distributed unmodified as part of this application, for use on Windows only,',
      '   and subject to those terms. WinRT.Runtime.dll originates from the C#/WinRT',
      '   project (https://github.com/microsoft/CsWinRT).',
      '',
    );
  }
  lines.push(applicationNotice);
  return `${lines.join('\n')}\n`;
}

/**
 * Copy the .NET runtime pack notices beside the published helper and write an
 * index naming every Microsoft component and its license. Returns what was staged.
 */
export async function stageDotnetRuntimeNotices({
  outputDir, depsJsonPath, helperName, nugetRoot = nugetPackagesRoot(), applicationNotice,
}) {
  const depsJson = JSON.parse(await readFile(depsJsonPath, 'utf8'));
  const { runtime, windowsSdk } = classifyRuntimePacks(resolveRuntimePacks(depsJson));
  const packDir = join(nugetRoot, runtime.id.toLowerCase(), runtime.version);
  const noticesDir = join(outputDir, NOTICES_DIRECTORY);
  const runtimeDir = join(noticesDir, DOTNET_NOTICES_DIRECTORY);
  await mkdir(runtimeDir, { recursive: true });
  const files = [];
  for (const file of DOTNET_NOTICE_FILES) {
    const source = join(packDir, file);
    try {
      await access(source);
    } catch {
      throw new Error(
        `${file} for ${runtime.id} ${runtime.version} is missing at ${source}; `
        + 'restore the NuGet runtime pack (dotnet restore) before packaging',
      );
    }
    await copyFile(source, join(runtimeDir, file));
    files.push(join(NOTICES_DIRECTORY, DOTNET_NOTICES_DIRECTORY, file));
  }
  await writeFile(join(noticesDir, NOTICES_README), renderNoticesReadme({ helperName, runtime, windowsSdk, applicationNotice }), 'utf8');
  files.push(join(NOTICES_DIRECTORY, NOTICES_README));
  await verifyDotnetRuntimeNotices(outputDir);
  return { runtime, windowsSdk, files };
}

/** Assert a staged or installed helper directory carries complete notices. */
export async function verifyDotnetRuntimeNotices(helperDir) {
  const noticesDir = join(helperDir, NOTICES_DIRECTORY);
  const readme = await readFile(join(noticesDir, NOTICES_README), 'utf8');
  assert.match(readme, /Microsoft\.NETCore\.App\.Runtime\.[A-Za-z0-9-]+ \d+\.\d+\.\d+/, 'Windows helper notices index must name the .NET runtime pack');
  const license = await readFile(join(noticesDir, DOTNET_NOTICES_DIRECTORY, 'LICENSE.TXT'), 'utf8');
  assert.ok(
    /MIT License/i.test(license) && license.includes('Permission is hereby granted')
      && license.includes('THE SOFTWARE IS PROVIDED "AS IS"'),
    'Windows helper .NET runtime LICENSE.TXT is missing or incomplete',
  );
  const notices = await readFile(join(noticesDir, DOTNET_NOTICES_DIRECTORY, 'THIRD-PARTY-NOTICES.TXT'), 'utf8');
  assert.ok(notices.trim().length > 1000, 'Windows helper .NET runtime THIRD-PARTY-NOTICES.TXT is missing or truncated');
  return true;
}
