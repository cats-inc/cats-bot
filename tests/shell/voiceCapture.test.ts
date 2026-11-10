// Ported from Cats Desktop tests/desktop-voice-capture-contract.test.js (cats-platform 6a2a1b02); SPEC-003 FR-10.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { VOICE_CAPTURE_ERROR_REASONS, VOICE_CAPTURE_MODES } from '../../src/shared/voice.ts';
import {
  DesktopVoiceCaptureController,
  parseVoiceCaptureHelperEvent,
  parseVoiceCaptureSessionId,
  parseVoiceCaptureStartOptions,
  resolveVoiceCaptureHelperPath,
} from '../../src/shell/electron/voiceCapture.ts';

test('the dictation contract has the modes and closed errors Cats Desktop has', () => {
  assert.deepEqual(VOICE_CAPTURE_MODES, ['on-device', 'cloud', 'unknown']);
  assert.deepEqual(VOICE_CAPTURE_ERROR_REASONS, [
    'permission_denied', 'permission_not_determined', 'mic_unavailable', 'language_not_supported',
    'engine_unavailable', 'helper_crashed', 'cancelled', 'aborted',
  ]);
});

test('start and session payloads from a note are validated', () => {
  assert.deepEqual(parseVoiceCaptureStartOptions({ sessionId: ' session-1 ', locale: ' en-US ' }), { sessionId: 'session-1', locale: 'en-US' });
  assert.deepEqual(parseVoiceCaptureStartOptions({ sessionId: 'session-1' }), { sessionId: 'session-1' });
  assert.equal(parseVoiceCaptureSessionId(' session-1 '), 'session-1');
  assert.throws(() => parseVoiceCaptureStartOptions({ sessionId: '' }), /Invalid/u);
  assert.throws(() => parseVoiceCaptureStartOptions({ sessionId: 'x', locale: '' }), /Invalid/u);
  assert.throws(() => parseVoiceCaptureSessionId(''), /Invalid/u);
});

test('the helper is found in the package, in a development build, or where the override says', () => {
  const config = { packaged: false, appPath: '/repo/cats-bot' };
  assert.equal(resolveVoiceCaptureHelperPath({ config, platform: 'darwin', env: {} }),
    join('/repo/cats-bot', 'build', 'native-macos', 'macos-stt', 'cats-stt-macos'));
  assert.equal(resolveVoiceCaptureHelperPath({ config, platform: 'win32', env: {}, arch: 'arm64' }),
    join('/repo/cats-bot', 'build', 'native-windows', 'arm64', 'windows-stt', 'cats-stt-windows.exe'));
  assert.equal(resolveVoiceCaptureHelperPath({ config: { packaged: true, appPath: '/x', resourcesPath: '/app/Resources' }, platform: 'darwin', env: {} }),
    join('/app/Resources', 'native', 'macos-stt', 'cats-stt-macos'));
  assert.equal(resolveVoiceCaptureHelperPath({ config: { packaged: true, appPath: '/x', resourcesPath: 'C:\\app\\resources' }, platform: 'win32', env: {} }),
    join('C:\\app\\resources', 'native', 'windows-stt', 'cats-stt-windows.exe'));
  assert.equal(resolveVoiceCaptureHelperPath({ config, platform: 'win32', env: { CATS_BOT_VOICE_HELPER: 'C:\\stt.exe' } }), 'C:\\stt.exe');
  assert.equal(resolveVoiceCaptureHelperPath({ config, platform: 'linux', env: {} }), null, 'no helper on Linux yet');
});

test('desktop voice capture parses helper events defensively', () => {
  assert.deepEqual(
    parseVoiceCaptureHelperEvent(JSON.stringify({
      type: 'ready',
      sessionId: 's1',
      locale: 'en-US',
      mode: 'on-device',
    })),
    { type: 'ready', sessionId: 's1', locale: 'en-US', mode: 'on-device' },
  );
  assert.deepEqual(
    parseVoiceCaptureHelperEvent(JSON.stringify({ type: 'final', sessionId: 's1', text: 'hello' })),
    { type: 'final', sessionId: 's1', text: 'hello' },
  );
  assert.deepEqual(
    parseVoiceCaptureHelperEvent(JSON.stringify({
      type: 'error',
      sessionId: 's1',
      reason: 'permission_denied',
    })),
    { type: 'error', sessionId: 's1', reason: 'permission_denied' },
  );
  assert.equal(
    parseVoiceCaptureHelperEvent(JSON.stringify({ type: 'ready', sessionId: 's1', mode: 'local' })),
    null,
  );
  assert.equal(
    parseVoiceCaptureHelperEvent(JSON.stringify({ type: 'error', sessionId: 's1', reason: 'bad' })),
    null,
  );
  assert.equal(parseVoiceCaptureHelperEvent('not json'), null);
});

test('desktop voice capture reports unavailable when the helper is missing', async () => {
  const events: any[] = [];
  const controller = new DesktopVoiceCaptureController({
    config: {
      packaged: false,
      appPath: '/tmp/missing-cats-bot',
    },
    platform: 'darwin',
    env: {},
    sendEvent: (event: any) => events.push(event),
    logLine: () => {},
  });

  await controller.startVoiceCapture({ sessionId: 's1', locale: 'en-US' });

  assert.deepEqual(events, [
    { type: 'error', sessionId: 's1', reason: 'engine_unavailable' },
    { type: 'end', sessionId: 's1' },
  ]);
});

test('desktop voice capture ready timeout reports unavailable and kills the helper', async () => {
  const workingDir = await mkdtemp(join(tmpdir(), 'cats-voice-helper-'));
  const helperPath = join(workingDir, 'helper');
  await writeFile(helperPath, '#!/bin/sh\n', 'utf8');
  const events: any[] = [];
  const child = createFakeChildProcess();
  const controller = new DesktopVoiceCaptureController({
    config: { packaged: false, appPath: workingDir },
    platform: 'darwin',
    env: { CATS_BOT_VOICE_HELPER: helperPath },
    sendEvent: (event: any) => events.push(event),
    spawnProcess: () => child,
    readyTimeoutMs: 5,
    logLine: () => {},
  });

  await controller.startVoiceCapture({ sessionId: 's1', locale: 'en-US' });
  await new Promise((resolve) => {
    setTimeout(resolve, 25);
  });

  assert.deepEqual(events, [
    { type: 'error', sessionId: 's1', reason: 'engine_unavailable' },
    { type: 'end', sessionId: 's1' },
  ]);
  assert.equal(child.killed, true);
});

test('desktop voice capture forwards current-session helper events and stop commands', async () => {
  const workingDir = await mkdtemp(join(tmpdir(), 'cats-voice-helper-'));
  const helperPath = join(workingDir, 'helper');
  await writeFile(helperPath, '#!/bin/sh\n', 'utf8');
  const events: any[] = [];
  const child = createFakeChildProcess();
  const controller = new DesktopVoiceCaptureController({
    config: { packaged: false, appPath: workingDir },
    platform: 'darwin',
    env: { CATS_BOT_VOICE_HELPER: helperPath },
    sendEvent: (event: any) => events.push(event),
    spawnProcess: () => child,
    logLine: () => {},
  });

  await controller.startVoiceCapture({ sessionId: 's1', locale: 'en-US' });
  child.stdout.emit('data', Buffer.from(`${JSON.stringify({
    type: 'ready',
    sessionId: 's1',
    locale: 'en-US',
    mode: 'unknown',
  })}\n`));
  child.stdout.emit('data', Buffer.from(`${JSON.stringify({
    type: 'partial',
    sessionId: 'stale',
    text: 'ignored',
  })}\n`));
  child.stdout.emit('data', Buffer.from(`${JSON.stringify({
    type: 'final',
    sessionId: 's1',
    text: 'hello',
  })}\n`));
  await controller.stopVoiceCapture('s1');
  child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'end', sessionId: 's1' })}\n`));

  assert.deepEqual(events, [
    { type: 'ready', sessionId: 's1', locale: 'en-US', mode: 'unknown' },
    { type: 'final', sessionId: 's1', text: 'hello' },
    { type: 'end', sessionId: 's1' },
  ]);
  assert.deepEqual(child.stdin.writes, [
    `${JSON.stringify({ type: 'stop', sessionId: 's1' })}\n`,
  ]);
});

test('desktop voice capture uses different cleanup windows for stop vs cancel', async () => {
  const workingDir = await mkdtemp(join(tmpdir(), 'cats-voice-helper-'));
  const helperPath = join(workingDir, 'helper');
  await writeFile(helperPath, '#!/bin/sh\n', 'utf8');

  async function startReadySession({ stopCleanupTimeoutMs, cancelCleanupTimeoutMs, sessionId }: { stopCleanupTimeoutMs?: number; cancelCleanupTimeoutMs?: number; sessionId: string }) {
    const events: any[] = [];
    const child = createFakeChildProcess();
    const controller = new DesktopVoiceCaptureController({
      config: { packaged: false, appPath: workingDir },
      platform: 'darwin',
      env: { CATS_BOT_VOICE_HELPER: helperPath },
      sendEvent: (event: any) => events.push(event),
      spawnProcess: () => child,
      stopCleanupTimeoutMs,
      cancelCleanupTimeoutMs,
      logLine: () => {},
    });
    await controller.startVoiceCapture({ sessionId });
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      type: 'ready',
      sessionId,
      locale: 'en-US',
      mode: 'on-device',
    })}\n`));
    return { child, controller, events };
  }

  // Cancel honors the short cleanup window and kills the helper inside it.
  const cancelRun = await startReadySession({
    stopCleanupTimeoutMs: 1_000,
    cancelCleanupTimeoutMs: 10,
    sessionId: 'cancel-window',
  });
  await cancelRun.controller.cancelVoiceCapture('cancel-window');
  await new Promise((resolve) => { setTimeout(resolve, 60); });
  assert.equal(
    cancelRun.child.killed,
    true,
    'cancel should kill the helper within cancelCleanupTimeoutMs',
  );

  // Stop uses the longer cleanup window — the helper must still be alive past
  // the cancel window so buffered finals can flush.
  const stopRun = await startReadySession({
    stopCleanupTimeoutMs: 200,
    cancelCleanupTimeoutMs: 10,
    sessionId: 'stop-window',
  });
  await stopRun.controller.stopVoiceCapture('stop-window');
  await new Promise((resolve) => { setTimeout(resolve, 60); });
  assert.equal(
    stopRun.child.killed,
    false,
    'stop should still be inside its cleanup window after the cancel window has elapsed',
  );
  await new Promise((resolve) => { setTimeout(resolve, 200); });
  assert.equal(
    stopRun.child.killed,
    true,
    'stop should eventually kill the helper after stopCleanupTimeoutMs',
  );
});

function createFakeChildProcess(): any {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  child.stdin = {
    writes: [],
    write(value: string) {
      this.writes.push(value);
      return true;
    },
  };
  return child;
}

test('a second note starting dictation ends the first session at once, with its end, and kills its helper', async () => {
  const workingDir = await mkdtemp(join(tmpdir(), 'cats-voice-helper-'));
  const helperPath = join(workingDir, 'helper');
  await writeFile(helperPath, '#!/bin/sh\n', 'utf8');
  const events: any[] = [];
  const children: any[] = [];
  const controller = new DesktopVoiceCaptureController({
    config: { packaged: false, appPath: workingDir },
    platform: 'darwin',
    env: { CATS_BOT_VOICE_HELPER: helperPath },
    sendEvent: (event: any) => events.push(event),
    spawnProcess: () => {
      const child = createFakeChildProcess();
      children.push(child);
      return child;
    },
    logLine: () => {},
  });
  await controller.startVoiceCapture({ sessionId: 'a' });
  children[0].stdout.emit('data', Buffer.from('{"type":"ready","sessionId":"a","locale":"en-US","mode":"on-device"}\n'));
  await controller.startVoiceCapture({ sessionId: 'b' });
  assert.deepEqual(events.filter((event) => event.sessionId === 'a').map((event) => event.type), ['ready', 'end']);
  assert.equal(children[0].killed, true);
  assert.match(children[0].stdin.writes.join(''), /"type":"cancel","sessionId":"a"/u);
  children[0].emit('close', 0);
  assert.equal(events.filter((event) => event.sessionId === 'a').length, 2, 'the old helper closing adds nothing');
  await controller.stopVoiceCapture('a');
  assert.equal(children[1].stdin.writes.length, 0, 'the old session cannot stop the new one');
  controller.dispose();
});
