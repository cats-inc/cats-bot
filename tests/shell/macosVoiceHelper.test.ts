import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

// @ts-expect-error The packaging script is plain JavaScript.
import * as helper from '../../scripts/macos-voice-helper.mjs';

/** SPEC-003 FR-10: the macOS dictation helper is built universal, staged and read back from the package. */

async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cats-macos-voice-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('the helper is built universal by default and staged where the package maps it', async (t) => {
  const root = await temporary(t);
  const bin = join(root, 'swift-bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'cats-stt-macos'), 'binary');
  const calls: string[][] = [];
  const run = (args: string[], cwd: string) => {
    assert.equal(cwd, root);
    calls.push(args);
    return args.includes('--show-bin-path') ? `${bin}\n` : '';
  };
  const built = await helper.buildMacosVoiceHelper(root, undefined, { run });
  const build = ['build', '-c', 'release', '--package-path', join(root, 'native', 'macos-stt'), '--arch', 'arm64', '--arch', 'x86_64'];
  assert.deepEqual(calls, [build, [...build, '--show-bin-path']]);
  assert.equal(built.output, join(root, 'build', 'native-macos', 'macos-stt', 'cats-stt-macos'));
  assert.equal(await readFile(built.output, 'utf8'), 'binary');
  // Windows has no execute bits; the helper is only built on macOS.
  if (process.platform !== 'win32') assert.equal((await stat(built.output)).mode & 0o111, 0o111, 'executable');
  await assert.rejects(helper.buildMacosVoiceHelper(root, ['ppc'], { run }), /must be among/u);
});

test('a package without the helper, or with an architecture missing, is refused', async (t) => {
  const resources = await temporary(t);
  await assert.rejects(helper.verifyPackagedMacosVoiceHelper(resources, undefined, { lipo: () => [] }), /lacks the dictation helper/u);
  await mkdir(join(resources, 'native', 'macos-stt'), { recursive: true });
  await writeFile(join(resources, 'native', 'macos-stt', 'cats-stt-macos'), 'binary');
  assert.deepEqual(await helper.verifyPackagedMacosVoiceHelper(resources, undefined, { lipo: () => ['x86_64', 'arm64'] }), { arches: ['x86_64', 'arm64'] });
  await assert.rejects(helper.verifyPackagedMacosVoiceHelper(resources, undefined, { lipo: () => ['arm64'] }), /lacks x86_64/u);
});

test('Windows and Linux packaging never runs swift', async (t) => {
  const root = await temporary(t);
  for (const platform of ['win32', 'linux']) {
    assert.deepEqual(await helper.main(['build'], { platform, root, run: () => assert.fail('swift must not run'), log: () => {} }), { skipped: true });
  }
});

test('the macOS package declares why it needs the microphone and speech recognition, and the entitlement', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.build.mac.extendInfo.NSMicrophoneUsageDescription, /Cats Bot/u);
  assert.match(pkg.build.mac.extendInfo.NSSpeechRecognitionUsageDescription, /Cats Bot/u);
  for (const file of ['entitlements.mac.plist', 'entitlements.mac.inherit.plist']) {
    const plist = await readFile(new URL(`../../assets/installer/${file}`, import.meta.url), 'utf8');
    for (const key of ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory',
      'com.apple.security.cs.disable-library-validation', 'com.apple.security.device.audio-input'])
      assert.match(plist, new RegExp(`<key>${key.replaceAll('.', '\\.')}</key>\\s*<true/>`, 'u'), `${file} ${key}`);
  }
});
