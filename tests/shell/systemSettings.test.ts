// Ported from Cats Desktop tests/desktop-system-settings.test.js (ADR-147); ADR-020.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SYSTEM_SETTINGS_PANES } from '../../src/shared/systemSettings.ts';
import {
  MACOS_SYSTEM_SETTINGS_URLS,
  createScreenCaptureAccessRequester,
  loginItemNeedsApproval,
  parseScreenCaptureRequestOutput,
  resolveMacosSystemSettingsUrl,
  shouldRequestScreenCaptureAccess,
} from '../../src/shell/electron/systemSettings.ts';

test('each pane has one constant macOS URL, and nothing else resolves', () => {
  assert.deepEqual(Object.keys(MACOS_SYSTEM_SETTINGS_URLS), [...SYSTEM_SETTINGS_PANES]);
  assert.equal(resolveMacosSystemSettingsUrl('microphone'),
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
  assert.equal(resolveMacosSystemSettingsUrl('speech_recognition'),
    'x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition');
  assert.equal(resolveMacosSystemSettingsUrl('screen_recording'),
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  assert.equal(resolveMacosSystemSettingsUrl('login_items'),
    'x-apple.systempreferences:com.apple.LoginItems-Settings.extension');
  for (const value of ['accessibility', 'x-apple.systempreferences:com.apple.preference.security', '', null, 7, {}]) {
    assert.throws(() => resolveMacosSystemSettingsUrl(value), /Unknown System Settings pane/u);
  }
});

test('the login item needs approval only for a packaged macOS app that macOS says so for', () => {
  const app = (status: string | undefined, isPackaged = true) => ({ isPackaged, getLoginItemSettings: () => ({ status }) });
  assert.equal(loginItemNeedsApproval(app('requires-approval'), 'darwin'), true);
  for (const status of ['enabled', 'not-registered', 'not-found', undefined]) {
    assert.equal(loginItemNeedsApproval(app(status), 'darwin'), false, String(status));
  }
  assert.equal(loginItemNeedsApproval(app('requires-approval', false), 'darwin'), false, 'a development run');
  assert.equal(loginItemNeedsApproval(app('requires-approval'), 'win32'), false);
  const throwing = { isPackaged: true, getLoginItemSettings: (): { status?: string } => { throw new Error('unavailable'); } };
  assert.equal(loginItemNeedsApproval(throwing, 'darwin'), false);
});

test('Screen Recording access is requested once per run, through the helper', async () => {
  const calls: string[][] = [];
  const logged: string[] = [];
  const request = createScreenCaptureAccessRequester({
    resolveHelperPath: () => '/Applications/Cats Bot.app/Contents/Resources/native/macos-stt/cats-stt-macos',
    run: async (helperPath, args) => {
      calls.push([helperPath, ...args]);
      return '{"type":"screen_capture","granted":false}\n';
    },
    log: (line) => logged.push(line),
  });
  assert.equal(await request(), true);
  assert.equal(await request(), false, 'a second capture in the same run does not ask again');
  assert.deepEqual(calls, [['/Applications/Cats Bot.app/Contents/Resources/native/macos-stt/cats-stt-macos', '--request-screen-capture']]);
  assert.deepEqual(logged, ['screen capture access requested (granted: false)']);

  const failing = createScreenCaptureAccessRequester({
    resolveHelperPath: () => '/missing/helper',
    run: async () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); },
    log: (line) => logged.push(line),
  });
  assert.equal(await failing(), true);
  assert.equal(logged.at(-1), 'screen capture access request failed: ENOENT');

  let ran = false;
  const noHelper = createScreenCaptureAccessRequester({ resolveHelperPath: () => null, run: async () => { ran = true; return ''; } });
  assert.equal(await noHelper(), false);
  assert.equal(ran, false);
});

test('any refused Screen Recording asks, since a never-asked app reads as denied', () => {
  for (const status of ['denied', 'not-determined', 'restricted', 'unknown']) {
    assert.equal(shouldRequestScreenCaptureAccess(status), true, status);
  }
  assert.equal(shouldRequestScreenCaptureAccess('granted'), false);
  assert.equal(shouldRequestScreenCaptureAccess(null), false, 'not macOS');
});

test('the helper reply is read strictly', () => {
  assert.equal(parseScreenCaptureRequestOutput('{"type":"screen_capture","granted":true}\n'), true);
  assert.equal(parseScreenCaptureRequestOutput('{"type":"screen_capture","granted":false}'), false);
  assert.equal(parseScreenCaptureRequestOutput('{"type":"ready","granted":true}'), undefined);
  assert.equal(parseScreenCaptureRequestOutput('not json'), undefined);
});
