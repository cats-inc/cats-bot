import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { AppUpdater } from 'electron-updater';
import type { IpcMainInvokeEvent } from 'electron';
import { configureUpdater, createUpdaterAdapter } from '../../src/shell/electron/update/adapter.ts';
import { BotUpdateController, InstallHandoffTimeout, type BotUpdater, type UpdateHooks } from '../../src/shell/electron/update/controller.ts';
import { BotInstallation, InstallationRecoveryRequired } from '../../src/shell/electron/update/installation.ts';
import { isUpdateSender, updateAction } from '../../src/shell/electron/update/ipc.ts';
import { assertNoOtherUsers } from '../../src/shell/electron/update/otherUsers.ts';
import { initialUpdateState, isNewerVersion, parseBotRelease, type BotRelease } from '../../src/shell/electron/update/release.ts';
import {
  TrayUpdateDialog,
  updateDialog,
  type UpdateDialog,
} from '../../src/shell/electron/update/dialog.ts';
import { showDesktopUpdateMessageBox } from '../../src/shell/electron/update/presenter.ts';

const release: BotRelease = {
  schemaVersion: 1, repository: 'cats-inc/cats-bot', version: '0.2.0', tag: 'v0.2.0', channel: 'preview',
  signingProfile: 'standard', distribution: 'standard-preview', platform: 'win32', architectures: ['x64', 'arm64'],
  trust: 'unsigned-no-certificate', sourceCommit: 'a'.repeat(40), runtimeCommit: 'b'.repeat(40),
};
const state = () => initialUpdateState({ packaged: true, version: release.version, release, portable: false });
const info = (version: string, file: string, sha512 = 'verified') => ({ updateInfo: { version, files: [{ url: file, sha512 }] } });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture(overrides: Partial<BotUpdater> = {}, hooks: Partial<UpdateHooks> = {}) {
  const events: string[] = [];
  const updater: BotUpdater = { check: async () => '0.3.0', download: async progress => { progress(50); }, prepareInstall: async () => undefined,
    install: async () => { events.push('install'); }, ...overrides };
  const controller = new BotUpdateController(state(), updater, {
    acquireInstall: () => { events.push('acquire'); return { handoff: () => { events.push('handoff'); }, release: () => { events.push('release'); } }; },
    drain: async () => { events.push('drain'); }, recover: async uncertain => { events.push(uncertain ? 'uncertain' : 'recover'); },
    openRelease: async url => { events.push(url); }, ...hooks,
  });
  return { controller, events };
}

test('tray check coalesces clicks into one result dialog and Later never downloads or interrupts work', async () => {
  const pending = deferred<string>();
  let checks = 0;
  const { controller, events } = fixture({
    check: () => {
      checks++;
      return pending.promise;
    },
    download: async () => {
      events.push('download');
    },
  });
  const shown: UpdateDialog[] = [];
  const flow = new TrayUpdateDialog({
    controller,
    locale: () => 'en',
    stopping: () => false,
    show: async (spec) => {
      shown.push(spec);
      return 1;
    },
  });
  const first = flow.open(),
    second = flow.open();
  assert.equal(first, second);
  pending.resolve('0.3.0');
  await first;
  assert.equal(checks, 1);
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0]?.buttons, ['Update and Restart', 'Later']);
  assert.deepEqual(events, []);
});

test('tray update confirmation downloads, drains and installs, without opening Settings', async () => {
  const { controller, events } = fixture({
    download: async () => {
      events.push('download');
    },
  });
  const shown: UpdateDialog[] = [];
  await new TrayUpdateDialog({
    controller,
    locale: () => 'zh-TW',
    stopping: () => false,
    show: async (spec) => {
      shown.push(spec);
      return 0;
    },
  }).open();
  assert.deepEqual(events, ['download', 'acquire', 'drain', 'handoff', 'install']);
  assert.deepEqual(shown[0]?.buttons, ['更新並重新啟動', '稍後']);
  assert.equal(shown.length, 1);
});

test('tray failure is shown and a stopped bot cannot start a newly confirmed install', async () => {
  const { controller, events } = fixture({
    download: async () => {
      throw new Error('download unavailable');
    },
  });
  const shown: UpdateDialog[] = [];
  await new TrayUpdateDialog({
    controller,
    locale: () => 'en',
    stopping: () => false,
    show: async (spec) => {
      shown.push(spec);
      return 0;
    },
  }).open();
  assert.deepEqual(
    shown.map((spec) => spec.title),
    ['Update available', 'Update failed'],
  );
  assert.equal(shown[1]?.message, 'download unavailable');
  assert.deepEqual(events, []);
  let stopping = false;
  const other = fixture();
  await new TrayUpdateDialog({
    controller: other.controller,
    locale: () => 'en',
    stopping: () => stopping,
    show: async () => {
      stopping = true;
      return 0;
    },
  }).open();
  assert.deepEqual(other.events, []);
});

test('dialog covers current, development, busy, downloaded and manual-update states', () => {
  assert.equal(
    updateDialog({ ...state(), phase: 'current' }, 'en').message,
    'Cats Bot 0.2.0 is up to date.',
  );
  assert.equal(updateDialog({ ...state(), phase: 'downloaded' }, 'en').action, 'install');
  assert.equal(
    updateDialog({ ...state(), phase: 'available', canInstall: false }, 'en').action,
    'release',
  );
  assert.equal(
    updateDialog({ ...state(), phase: 'downloading', percent: 25.4 }, 'en').message,
    'Downloading update… 25%',
  );
  assert.equal(
    updateDialog(
      initialUpdateState({ packaged: false, version: '0.2.0', release: null, portable: false }),
      'en',
    ).action,
    'none',
  );
});

test('Windows/Linux tray dialogs are parentless; macOS uses a native sheet owner and always destroys it', async () => {
  const spec = updateDialog({ ...state(), phase: 'current' }, 'en');
  for (const platform of ['win32', 'linux', 'darwin']) {
    const events: string[] = [];
    const owner = {
      show() {
        events.push('show');
      },
      focus() {
        events.push('focus');
      },
      isDestroyed: () => false,
      destroy() {
        events.push('destroy');
      },
    };
    assert.equal(
      await showDesktopUpdateMessageBox({
        platform,
        dialogSpec: spec,
        createOwner: (options) => {
          assert.equal(options.skipTaskbar, true);
          assert.equal(options.width, 1);
          events.push('create');
          return owner;
        },
        focusApp: () => {
          events.push('app');
        },
        showMessageBox: async (options, actualOwner) => {
          assert.equal(options.message, spec.message);
          assert.equal(actualOwner, platform === 'darwin' ? owner : undefined);
          events.push('dialog');
          return { response: 0, checkboxChecked: false };
        },
      }),
      0,
    );
    assert.deepEqual(
      events,
      platform === 'darwin'
        ? ['create', 'show', 'dialog', 'app', 'focus', 'destroy']
        : ['app', 'dialog'],
    );
  }
});

test('only published matching identities enable checks; portable and unsigned macOS remain manual', () => {
  assert.ok(parseBotRelease(release, '0.2.0', 'win32', 'x64'));
  for (const patch of [{ version: '0.1.0' }, { repository: 'attacker/repo' }, { distribution: 'candidate' }, { sourceCommit: 'main' }]) {
    assert.equal(parseBotRelease({ ...release, ...patch }, '0.2.0', 'win32', 'x64'), null);
  }
  assert.equal(parseBotRelease(release, '0.2.0', 'linux', 'x64'), null);
  assert.equal(initialUpdateState({ packaged: false, version: '0.2.0', release, portable: false }).canCheck, false);
  assert.equal(initialUpdateState({ packaged: true, version: '0.2.0', release: null, portable: false }).canInstall, false);
  assert.equal(initialUpdateState({ packaged: true, version: '0.2.0', release, portable: true }).canInstall, false);
  assert.equal(initialUpdateState({ packaged: true, version: '0.2.0', release: { ...release, platform: 'darwin' }, portable: false }).canInstall, false);
  assert.equal(initialUpdateState({ packaged: true, version: '0.2.0', release: { ...release, platform: 'darwin', trust: 'signed-notarized' }, portable: false }).canInstall, true);
});

test('updates require a strictly newer plain version, never equality, downgrade or malformed input', async () => {
  for (const version of ['0.2.0', '0.1.9', '0.3.0-preview', '01.3.0', 'https://evil', null]) {
    assert.equal(isNewerVersion(version, '0.2.0'), false);
    assert.equal((await fixture({ check: async () => version }).controller.check()).phase, 'current');
  }
  assert.equal(isNewerVersion('0.10.0', '0.9.0'), true);
});

test('check is coalesced; download and installation are explicit with drain before installer', async () => {
  const pending = deferred<string>(); let checks = 0;
  const { controller, events } = fixture({ check: () => { checks++; return pending.promise; } });
  const first = controller.check(), second = controller.check();
  await Promise.resolve(); assert.equal(checks, 1);
  pending.resolve('0.3.0'); await Promise.all([first, second]);
  assert.equal(controller.snapshot().phase, 'available'); assert.deepEqual(events, []);
  await controller.install(); assert.deepEqual(events, [], 'cannot install before an explicit download');
  await controller.download(); await controller.check();
  assert.equal(checks, 1, 'a completed download cannot be replaced by a tray check');
  await updateAction(controller, 'install', async () => false); assert.deepEqual(events, []);
  await updateAction(controller, 'install', async () => true);
  assert.deepEqual(events, ['acquire', 'drain', 'handoff', 'install']);
});

test('another live bot prevents draining; drain failure releases gate; uncertain handoff keeps gate', async () => {
  const blocked = fixture({}, { acquireInstall: () => { throw new Error('other Bot'); } });
  await blocked.controller.check(); await blocked.controller.download(); await blocked.controller.install();
  assert.deepEqual(blocked.events, []); assert.match(blocked.controller.snapshot().error!, /other Bot/u);
  const failed = fixture({}, { drain: async () => { throw new Error('runtime still running'); } });
  await failed.controller.check(); await failed.controller.download(); await failed.controller.install();
  assert.deepEqual(failed.events, ['acquire', 'release', 'recover']);
  const uncertain = fixture({ install: async () => { throw new InstallHandoffTimeout('pending'); } });
  await uncertain.controller.check(); await uncertain.controller.download(); await uncertain.controller.install();
  assert.deepEqual(uncertain.events, ['acquire', 'drain', 'handoff', 'uncertain']);
});

test('update IPC only accepts the owned Settings main frame and explicit actions', async () => {
  const mainFrame = {}, sender = { id: 7, mainFrame };
  assert.equal(isUpdateSender({ sender, senderFrame: mainFrame } as IpcMainInvokeEvent, id => id === 7), true);
  assert.equal(isUpdateSender({ sender, senderFrame: {} } as IpcMainInvokeEvent, id => id === 7), false);
  assert.equal(isUpdateSender({ sender, senderFrame: mainFrame } as IpcMainInvokeEvent, () => false), false);
  await assert.rejects(
    updateAction(fixture().controller, 'https://example.com/install.exe', async () => true),
    /Unknown/u,
  );
});

test('updater disables automatic install/download and configures the plain-version preview feed', () => {
  const raw = { allowDowngrade: true, setFeedURL(value: unknown) { assert.deepEqual(value, { provider: 'github', owner: 'cats-inc', repo: 'cats-bot' }); } };
  configureUpdater(raw as AppUpdater);
  assert.equal(raw.allowDowngrade, false);
  assert.equal((raw as unknown as AppUpdater).autoDownload, false);
  assert.equal((raw as unknown as AppUpdater).autoInstallOnAppQuit, false);
  assert.equal((raw as unknown as AppUpdater).channel, null);
});

test('timed-out native download remains fenced until settled and cannot become a newer download', async () => {
  const native = new EventEmitter(); const old = deferred<string[]>(); let checks = 0;
  Object.assign(native, { checkForUpdates: async () => info(++checks === 1 ? '0.3.0' : '0.4.0', 'old.exe'), downloadUpdate: () => old.promise });
  const adapter = createUpdaterAdapter(native as AppUpdater, { onQuit: () => () => undefined, fingerprint: async () => 'verified' }, 15);
  await adapter.check();
  await assert.rejects(adapter.download(() => undefined), /timed out/u);
  await assert.rejects(adapter.check(), /still finishing/u);
  assert.equal(checks, 1);
  native.emit('update-downloaded', { version: '0.3.0' }); old.resolve([resolve('old.exe')]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await adapter.check(), '0.4.0');
  await assert.rejects(adapter.install(), /matching download/u);
});

test('downloaded event with a different version is rejected even when the native promise succeeds', async () => {
  const native = new EventEmitter();
  Object.assign(native, { checkForUpdates: async () => info('0.3.0', 'wrong.exe'), downloadUpdate: async () => {
    native.emit('update-downloaded', { version: '0.4.0' }); return [resolve('wrong.exe')];
  } });
  const adapter = createUpdaterAdapter(native as AppUpdater, { onQuit: () => () => undefined });
  await adapter.check(); await assert.rejects(adapter.download(() => undefined), /identity changed/u);
  await assert.rejects(adapter.install(), /matching download/u);
});

test('installer that never hands off is uncertain and Linux receives only the verified download path', async () => {
  const native = new EventEmitter(); let passed: string | undefined;
  const verified = resolve('verified.deb');
  Object.assign(native, { checkForUpdates: async () => info('0.3.0', 'verified.deb'), downloadUpdate: async () => {
    native.emit('update-downloaded', { version: '0.3.0' }); return [verified];
  } });
  const adapter = createUpdaterAdapter(native as AppUpdater, { onQuit: () => () => undefined, fingerprint: async () => 'verified',
    installDeb: async file => { passed = file; } }, 15);
  await adapter.check(); await adapter.download(() => undefined);
  await assert.rejects(adapter.install(), InstallHandoffTimeout); assert.equal(passed, verified);
});

test('installation gate excludes existing and newly starting Bots, then preserves bot id across upgrade', t => {
  const root = mkdtempSync(join(tmpdir(), 'cats-update-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const live = new Set([101, 102, 103]); const alive = (pid: number) => live.has(pid);
  const first = new BotInstallation(root, join(root, 'app'), '0.2.0', 101, alive);
  const other = new BotInstallation(root, join(root, 'app'), '0.2.0', 102, alive);
  first.register('nori'); other.register('mochi');
  assert.throws(() => first.acquire('0.3.0'), /other Cats Bot/u);
  other.unregister(); const lease = first.acquire('0.3.0');
  assert.throws(() => other.register('mochi'), /installing/u);
  lease.handoff(); first.unregister(); live.delete(101);
  assert.equal(other.pendingBotId(), 'nori');
  assert.throws(() => other.register('mochi'), InstallationRecoveryRequired);
  const updated = new BotInstallation(root, join(root, 'app'), '0.3.0', 103, alive);
  updated.register(updated.pendingBotId()!); const next = updated.acquire('0.4.0'); next.release(); updated.unregister();
});

test('crashed owner, reused PID and incomplete gate have explicit safe recovery', t => {
  const root = mkdtempSync(join(tmpdir(), 'cats-update-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const bot = new BotInstallation(root, join(root, 'app'), '0.2.0', 101, () => false);
  mkdirSync(bot.directory, { recursive: true }); writeFileSync(join(bot.directory, 'pid-101.json'), '{old lease}');
  bot.register('nori'); const lease = bot.acquire('0.3.0'); lease.handoff(); bot.unregister();
  assert.throws(() => bot.register('nori'), InstallationRecoveryRequired);
  bot.acknowledgeFinishedInstaller(); bot.register('nori'); bot.unregister();
  mkdirSync(join(bot.directory, 'install')); writeFileSync(join(bot.directory, 'install', 'owner.json'), '{');
  assert.throws(() => bot.register('nori'), InstallationRecoveryRequired);
  bot.acknowledgeFinishedInstaller(); bot.register('nori'); bot.unregister();
});

test('shared Unix installations refuse replacement while another account runs the app', () => {
  assertNoOtherUsers('/opt/Cats Bot/cats-bot', 'linux', 1000, () => '123 1000 /opt/Cats Bot/cats-bot\n456 2000 /usr/bin/bash');
  assert.throws(() => assertNoOtherUsers('/opt/Cats Bot/cats-bot', 'linux', 1000, () => '123 2000 /opt/Cats Bot/cats-bot'), /Another signed-in user/u);
  assert.throws(() => assertNoOtherUsers('/Applications/Cats Bot.app/Contents/MacOS/Cats Bot', 'darwin', 501,
    () => '123 502 /Applications/Cats Bot.app/Contents/Frameworks/Cats Bot Helper.app/Contents/MacOS/Cats Bot Helper'), /Another signed-in user/u);
  assert.throws(() => assertNoOtherUsers('/opt/Cats Bot/cats-bot', 'linux', 1000, () => ''), /Cannot verify/u);
});

test('evicted or changed native cache is rejected under the installation gate before stopping the Bot', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cats-update-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'installer.exe'); let realDownloads = 0;
  const expectedHash = createHash('sha512').update('verified update bytes').digest('base64');
  const native = new EventEmitter();
  Object.assign(native, { checkForUpdates: async () => info('0.3.0', 'installer.exe', expectedHash), downloadUpdate: async () => {
    // Match pinned helper's in-memory shortcut: an existing file is reused
    // without hashing again, even when a prior owner changed its contents.
    if (!existsSync(file)) { writeFileSync(file, 'verified update bytes'); realDownloads++; }
    native.emit('update-downloaded', { version: '0.3.0' }); return [file];
  } });
  const adapter = createUpdaterAdapter(native as AppUpdater, { onQuit: () => () => undefined });
  const { controller, events } = fixture(adapter);
  await controller.check(); await controller.download(); assert.equal(controller.snapshot().phase, 'downloaded');
  writeFileSync(file, 'a different update'); await controller.install();
  assert.deepEqual(events, ['acquire', 'release'], 'the live Bot was never drained');
  assert.match(controller.snapshot().error!, /removed or changed/u);
  await controller.check(); await controller.download();
  assert.match(controller.snapshot().error!, /checksum validation/u);
  assert.equal(realDownloads, 1, 'the stale native cache really was reused');
  assert.equal(existsSync(file), false, 'bad cache is removed so retry can recover');
  await controller.check(); await controller.download(); assert.equal(controller.snapshot().phase, 'downloaded'); assert.equal(realDownloads, 2);
  rmSync(file); await controller.install();
  assert.deepEqual(events, ['acquire', 'release', 'acquire', 'release']);
  assert.equal(controller.snapshot().phase, 'error');
});
