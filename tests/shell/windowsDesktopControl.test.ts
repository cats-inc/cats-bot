import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';

// SPEC-006 BDC-11 / PLAN-006 P1. Packaging scripts are plain JavaScript; these tests
// never run dotnet, PowerShell or electron-builder, so they pass on every CI platform.
const notices = await import(new URL('../../scripts/dotnet-runtime-notices.mjs', import.meta.url).href);
const helper = await import(new URL('../../scripts/windows-desktop-control.mjs', import.meta.url).href);
const repoRoot = resolve(import.meta.dirname, '..', '..');

const DOTNET_LICENSE = `The MIT License (MIT)

Copyright (c) .NET Foundation and Contributors

All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED.
`;
const DOTNET_NOTICES = `.NET Runtime uses third-party libraries or other resources that may be
distributed under licenses different than the .NET Runtime software.
${'License details for a bundled component.\n'.repeat(40)}`;

const depsJson = (rid = 'win-x64', version = '8.0.31', sdk: string | null = '10.0.19041.57') => ({
  runtimeTarget: { name: `.NETCoreApp,Version=v8.0/${rid}` },
  targets: {
    '.NETCoreApp,Version=v8.0': {},
    [`.NETCoreApp,Version=v8.0/${rid}`]: {
      'cats-desktop-control-windows/1.0.0': { dependencies: {} },
      [`runtimepack.Microsoft.NETCore.App.Runtime.${rid}/${version}`]: { runtime: {} },
      ...(sdk ? { [`runtimepack.Microsoft.Windows.SDK.NET.Ref/${sdk}`]: { runtime: {} } } : {}),
    },
  },
});

async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cats-bots-dc-helper-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function seedNugetRoot(root: string, rid = 'win-x64', version = '8.0.31'): Promise<string> {
  const pack = join(root, `microsoft.netcore.app.runtime.${rid}`, version);
  await mkdir(pack, { recursive: true });
  await writeFile(join(pack, 'LICENSE.TXT'), DOTNET_LICENSE);
  await writeFile(join(pack, 'THIRD-PARTY-NOTICES.TXT'), DOTNET_NOTICES);
  return pack;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** A minimal PE image whose COFF header names the given machine. */
function peImage(arch: 'x64' | 'arm64'): Buffer {
  const image = Buffer.alloc(0x90);
  image.write('MZ', 0, 'latin1');
  image.writeUInt32LE(0x80, 0x3c);
  image.write('PE\0\0', 0x80, 'latin1');
  image.writeUInt16LE(arch === 'x64' ? 0x8664 : 0xaa64, 0x84);
  return image;
}

test('deps.json resolution names the exact runtime packs the helper was published with', () => {
  assert.deepEqual(notices.resolveRuntimePacks(depsJson()), [
    { id: 'Microsoft.NETCore.App.Runtime.win-x64', version: '8.0.31' },
    { id: 'Microsoft.Windows.SDK.NET.Ref', version: '10.0.19041.57' },
  ]);
  const arm = notices.classifyRuntimePacks(notices.resolveRuntimePacks(depsJson('win-arm64', '8.0.32', null)));
  assert.deepEqual(arm, { runtime: { id: 'Microsoft.NETCore.App.Runtime.win-arm64', version: '8.0.32' }, windowsSdk: null });
  assert.throws(() => notices.classifyRuntimePacks([]), /not self-contained/u);
  assert.equal(notices.nugetPackagesRoot({ NUGET_PACKAGES: 'C:\\nuget' }, 'C:\\home'), 'C:\\nuget');
  assert.equal(notices.nugetPackagesRoot({}, '/home/bot'), join('/home/bot', '.nuget', 'packages'));
});

test('staged notices carry the runtime license texts and an index naming every Microsoft component', async (t) => {
  const root = await temporary(t);
  const nugetRoot = join(root, 'nuget');
  await seedNugetRoot(nugetRoot);
  const outputDir = join(root, 'helper');
  await mkdir(outputDir);
  const depsJsonPath = join(outputDir, 'cats-desktop-control-windows.deps.json');
  await writeFile(depsJsonPath, JSON.stringify(depsJson()));

  const staged = await notices.stageDotnetRuntimeNotices({ outputDir, depsJsonPath, helperName: 'cats-desktop-control-windows.exe', nugetRoot });
  assert.equal(staged.runtime.version, '8.0.31');
  const readme = await readFile(join(outputDir, 'licenses', 'README.txt'), 'utf8');
  assert.match(readme, /bundled with cats-desktop-control-windows\.exe/u);
  assert.match(readme, /Microsoft\.NETCore\.App\.Runtime\.win-x64 8\.0\.31/u);
  assert.match(readme, /Microsoft\.Windows\.SDK\.NET\.Ref 10\.0\.19041\.57/u);
  assert.match(readme, /Cats Bot itself is licensed separately/u);
  assert.equal(await readFile(join(outputDir, 'licenses', 'dotnet-runtime', 'LICENSE.TXT'), 'utf8'), DOTNET_LICENSE);
  assert.equal(await notices.verifyDotnetRuntimeNotices(outputDir), true);

  await writeFile(join(outputDir, 'licenses', 'dotnet-runtime', 'THIRD-PARTY-NOTICES.TXT'), 'truncated');
  await assert.rejects(notices.verifyDotnetRuntimeNotices(outputDir), /truncated/u);

  // A runtime pack that was never restored fails closed instead of shipping without texts.
  await writeFile(depsJsonPath, JSON.stringify(depsJson('win-x64', '8.0.99')));
  await assert.rejects(
    notices.stageDotnetRuntimeNotices({ outputDir, depsJsonPath, helperName: 'cats-desktop-control-windows.exe', nugetRoot }),
    /missing at .*restore the NuGet runtime pack/u,
  );
});

test('publishing runs dotnet once per architecture, self-contained, and clears stale helpers first', async (t) => {
  const root = await temporary(t);
  const nugetRoot = join(root, 'nuget');
  await seedNugetRoot(nugetRoot, 'win-x64');
  await seedNugetRoot(nugetRoot, 'win-arm64');
  const stale = join(root, 'build', 'native-windows', 'ia32', 'windows-desktop-control', 'cats-desktop-control-windows.exe');
  await mkdir(join(stale, '..'), { recursive: true });
  await writeFile(stale, 'stale');

  const calls: string[][] = [];
  const run = async (args: string[], cwd: string) => {
    assert.equal(cwd, root);
    calls.push(args);
    const outputDir = args[args.indexOf('-o') + 1]!;
    const rid = args[args.indexOf('-r') + 1]!;
    await writeFile(join(outputDir, 'cats-desktop-control-windows.deps.json'), JSON.stringify(depsJson(rid)));
  };
  const published = await helper.publishWindowsDesktopControl(root, ['x64', 'arm64'], { run, nugetRoot });

  assert.deepEqual(calls, ['x64', 'arm64'].map((arch) => [
    'publish', join(root, 'native', 'windows-desktop-control', 'CatsDesktopControlWindows.csproj'),
    '-c', 'Release', '-r', `win-${arch}`, '--self-contained', 'true',
    '-o', join(root, 'build', 'native-windows', arch, 'windows-desktop-control'),
  ]));
  assert.deepEqual(published.map((item: { arch: string }) => item.arch), ['x64', 'arm64']);
  assert.equal(await exists(stale), false);
  for (const arch of ['x64', 'arm64']) {
    assert.equal(await notices.verifyDotnetRuntimeNotices(helper.helperOutputDirectory(root, arch)), true);
  }

  calls.length = 0;
  await assert.rejects(helper.publishWindowsDesktopControl(root, ['ia32'], { run, nugetRoot }), /must be among x64, arm64/u);
  await assert.rejects(helper.publishWindowsDesktopControl(root, [], { run, nugetRoot }), /must be among/u);
  assert.deepEqual(calls, []);
});

test('macOS and Linux packaging never runs dotnet', async (t) => {
  const root = await temporary(t);
  const run = () => assert.fail('dotnet must not run off Windows');
  const logged: string[] = [];
  const log = (line: string) => logged.push(line);
  for (const platform of ['darwin', 'linux']) {
    assert.deepEqual(await helper.main(['publish'], { platform, root, run, log }), { skipped: true });
    assert.deepEqual(await helper.main(['verify', '--arch', 'arm64'], { platform, root, log }), { skipped: true });
  }
  assert.equal(await exists(join(root, 'build')), false);
  assert.equal(logged.length, 4);
  await assert.rejects(helper.main(['sign'], { platform: 'win32', root }), /Usage/u);
});

test('a packaged Windows app must carry the helper for its own architecture with its notices', async (t) => {
  const root = await temporary(t);
  const nugetRoot = join(root, 'nuget');
  await seedNugetRoot(nugetRoot);
  const unpacked = async (arch: 'x64' | 'arm64', helperArch: 'x64' | 'arm64' | null, withNotices = true) => {
    const resources = helper.unpackedResources(join(root, `${arch}-${helperArch}-${withNotices}`), arch);
    const helperDir = join(resources, 'native', 'windows-desktop-control');
    await mkdir(helperDir, { recursive: true });
    await writeFile(join(resources, '..', 'Cats Bot.exe'), peImage(arch));
    if (helperArch) await writeFile(join(helperDir, 'cats-desktop-control-windows.exe'), peImage(helperArch));
    if (withNotices) {
      const depsJsonPath = join(helperDir, 'cats-desktop-control-windows.deps.json');
      await writeFile(depsJsonPath, JSON.stringify(depsJson()));
      await notices.stageDotnetRuntimeNotices({ outputDir: helperDir, depsJsonPath, helperName: 'cats-desktop-control-windows.exe', nugetRoot });
    }
    return resources;
  };

  assert.deepEqual(await helper.verifyPackagedWindowsDesktopControl(await unpacked('x64', 'x64')), { arch: 'x64' });
  assert.deepEqual(await helper.verifyPackagedWindowsDesktopControl(await unpacked('arm64', 'arm64')), { arch: 'arm64' });
  await assert.rejects(helper.verifyPackagedWindowsDesktopControl(await unpacked('arm64', 'x64')),
    /desktop control helper is x64 but the app is arm64/u);
  await assert.rejects(helper.verifyPackagedWindowsDesktopControl(await unpacked('x64', null)), /lacks the desktop control helper/u);
  await assert.rejects(helper.verifyPackagedWindowsDesktopControl(await unpacked('x64', 'x64', false)), /ENOENT/u);

  assert.equal(helper.unpackedResources('r', 'x64'), join('r', 'release', 'win-unpacked', 'resources'));
  assert.equal(helper.unpackedResources('r', 'arm64'), join('r', 'release', 'win-arm64-unpacked', 'resources'));
  const notPe = join(root, 'not-pe.exe');
  await writeFile(notPe, Buffer.alloc(0x90));
  await assert.rejects(helper.readPeArchitecture(notPe), /not a PE executable/u);
});

test('only Windows packages map the helper, and every Windows packaging path publishes it first', async () => {
  const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.build.win.extraResources, [{
    from: 'build/native-windows/${arch}/windows-desktop-control',
    to: 'native/windows-desktop-control',
    filter: ['**/*'],
  }]);
  for (const section of [pkg.build, pkg.build.mac, pkg.build.linux, pkg.build.nsis, pkg.build.portable]) {
    assert.equal(JSON.stringify(section.extraResources ?? []).includes('native'), false);
  }
  assert.equal(JSON.stringify(pkg.build.files).includes('build/'), false);
  for (const script of ['dist:win', 'dist:dir']) {
    const steps = pkg.scripts[script].split(' && ');
    assert.equal(steps[0], 'node scripts/windows-desktop-control.mjs publish');
    assert.match(steps[1], /^electron-builder /u);
    assert.equal(steps[2], 'node scripts/windows-desktop-control.mjs verify');
  }
  const preview = await readFile(join(repoRoot, 'scripts', 'build-preview.mjs'), 'utf8');
  assert.match(preview, /publishWindowsDesktopControl\(root, args\.includes\('--dir'\) \? \['x64'\] : \['x64', 'arm64'\]\)/u);
  assert.match(preview, /verifyPackagedWindowsDesktopControl\(resources\)/u);
});

test('the helper keeps the frozen SPEC-133 exclusion lists', async () => {
  const source = await readFile(join(repoRoot, 'native', 'windows-desktop-control', 'Exclusions.cs'), 'utf8');
  const list = (name: string) => {
    const body = new RegExp(`${name} = new\\(StringComparer\\.OrdinalIgnoreCase\\)\\s*\\{([^}]*)\\}`, 'u').exec(source)?.[1];
    assert.ok(body, `Exclusions.cs declares ${name}`);
    return [...body.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
  };
  assert.deepEqual(list('Excluded'), ['consent.exe', 'LogonUI.exe', 'CredentialUIBroker.exe', 'LockApp.exe']);
  assert.deepEqual(list('TerminalsAndIdes'), [
    'WindowsTerminal.exe', 'OpenConsole.exe', 'conhost.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'wsl.exe',
    'bash.exe', 'mintty.exe', 'Code.exe', 'Code - Insiders.exe', 'Cursor.exe', 'Windsurf.exe', 'devenv.exe',
    'idea64.exe', 'pycharm64.exe', 'webstorm64.exe', 'rider64.exe', 'clion64.exe', 'goland64.exe', 'rubymine64.exe',
    'phpstorm64.exe', 'datagrip64.exe', 'studio64.exe', 'zed.exe',
  ]);
  assert.deepEqual(list('Browsers'), [
    'chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'vivaldi.exe', 'arc.exe', 'iexplore.exe',
  ]);
});
