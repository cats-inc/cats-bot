import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import {
  createDesktopControlHelperClient,
  developmentHelperPath,
  packagedHelperPath,
  resolveDesktopControlHelper,
} from '../../src/core/desktopControl/helper.ts';
import { evaluateDesktopControlPolicy } from '../../src/core/desktopControl/policy.ts';
import { DesktopControlService, type DesktopControlChange, type DesktopControlTurn } from '../../src/core/desktopControl/service.ts';
import { DesktopControlSwitches } from '../../src/core/desktopControl/switches.ts';
import {
  DESKTOP_CONTROL_ERROR_CODES,
  DESKTOP_CONTROL_TOOLS,
  desktopToolInputSummary,
  desktopToolResultSummary,
  isDesktopControlToolName,
} from '../../src/core/desktopControl/tools.ts';
import type { SessionCapabilitiesSnapshot } from '../../src/core/types.ts';
import {
  callDesktopTool,
  CAPTURE_BOUNDS,
  defaultWorld,
  errorCode,
  fakeHelper,
  NOTEPAD,
  PNG_BYTES,
  SECRET_CLIPBOARD,
  SECRET_TITLE,
  SECRET_TYPED,
  SECRET_UI_VALUE,
  snapshot,
  waitUntil,
  type FakeWorld,
} from '../support/desktopControl.ts';
import { makeTempHome } from '../support/harness.ts';

/**
 * SPEC-006 against a fake helper: the DC-04 policy gate, the descriptor and turn rules
 * (BDC-04, BDC-05), grants only the owner answers (BDC-07, SPEC-133 DC-08), the phase A and
 * phase B tools, holding control (DC-11), stop, lock, off and unavailable states, the helper's
 * crash limit and the switch store. These ports of Platform's desktop-control.test.js
 * scenarios run the Bot's own code.
 */

interface Fixture {
  service: DesktopControlService;
  world: FakeWorld;
  helper: ReturnType<typeof fakeHelper>;
  switches: DesktopControlSwitches;
  profile: { enabled: boolean };
  turn: { current: DesktopControlTurn | null };
  changes: DesktopControlChange[];
  logs: string[];
  snapshotFor: { current: SessionCapabilitiesSnapshot | null };
  clock: { now: number };
  /** Re-decides the descriptor the way the core does before a send, and returns it. */
  send(conversationId?: string, sessionId?: string): Promise<ReturnType<DesktopControlService['descriptorFor']>[number] | undefined>;
}

async function fixture(t: TestContext, overrides: { world?: Partial<FakeWorld>; helper?: null; grantWaitMs?: number;
  requestTtlMs?: number; snapshot?: SessionCapabilitiesSnapshot | null } = {}): Promise<Fixture> {
  const home = makeTempHome('cats-desktop-control-');
  const world: FakeWorld = { ...defaultWorld(), ...overrides.world };
  const helper = fakeHelper(world);
  const switches = new DesktopControlSwitches(join(home.botsHome, 'desktop-control.json'));
  switches.set('conv-1', true);
  const profile = { enabled: true };
  const turn: Fixture['turn'] = { current: null };
  const changes: DesktopControlChange[] = [];
  const logs: string[] = [];
  const snapshotFor: Fixture['snapshotFor'] = { current: overrides.snapshot === undefined ? snapshot() : overrides.snapshot };
  const clock = { now: Date.now() };
  const service = new DesktopControlService({
    helper: overrides.helper === null ? null : createDesktopControlHelperClient({
      path: 'fake.exe', selfProcessIds: [process.pid], selfExecutables: ['C:\\Bot\\Cats Bot.exe'], spawn: helper.spawn,
    }),
    unavailableReason: overrides.helper === null ? 'not_windows' : null,
    switches,
    profileEnabled: () => profile.enabled,
    capabilities: async () => snapshotFor.current,
    turn: () => turn.current,
    changed: (change) => changes.push(change),
    log: (line) => logs.push(line),
    serverVersion: 'test',
    selfExecutables: ['C:\\Bot\\Cats Bot.exe'],
    grantWaitMs: overrides.grantWaitMs ?? 300,
    ...(overrides.requestTtlMs !== undefined ? { requestTtlMs: overrides.requestTtlMs } : {}),
    now: () => clock.now,
  });
  t.after(async () => {
    service.close();
    await service.stopServer();
    home.cleanup();
  });
  return {
    service, world, helper, switches, profile, turn, changes, logs, snapshotFor, clock,
    async send(conversationId = 'conv-1', sessionId = 'session-1') {
      await service.refresh(conversationId, sessionId);
      return service.descriptorFor(conversationId, sessionId)[0];
    },
  };
}

const owner = (sessionId = 'session-1', workItemId = 'item-1'): DesktopControlTurn => ({ sessionId, workItemId, ownerPresent: true });
const background = (): DesktopControlTurn => ({ sessionId: 'session-1', workItemId: 'item-1', ownerPresent: false });

test('DC-04 policy gate passes only explicit interactive approval and fails closed', () => {
  assert.deepEqual(evaluateDesktopControlPolicy(snapshot()), { ok: true });
  assert.deepEqual(evaluateDesktopControlPolicy(snapshot({ approval: 'untrusted', status: 'not_observed' })), { ok: true });
  assert.equal((evaluateDesktopControlPolicy(snapshot({ approval: 'never' })) as { reason: string }).reason, 'policy_preapproves_tools');
  assert.equal((evaluateDesktopControlPolicy(snapshot({ status: 'mismatch' })) as { reason: string }).reason, 'policy_mismatch');
  assert.equal((evaluateDesktopControlPolicy(snapshot({ status: 'unsupported' })) as { reason: string }).reason, 'policy_unsupported');
  assert.equal((evaluateDesktopControlPolicy(snapshot({ source: 'provider' })) as { reason: string }).reason, 'policy_not_explicit');
  assert.equal((evaluateDesktopControlPolicy(snapshot({ host: false })) as { reason: string }).reason, 'no_tool_approval_host');
  assert.equal((evaluateDesktopControlPolicy(null) as { reason: string }).reason, 'policy_unknown');
  assert.equal((evaluateDesktopControlPolicy({ version: 1, sessionId: 's', workerGeneration: null, supported: false }) as { reason: string }).reason,
    'policy_unknown');
});

test('the tool list and error codes are SPEC-133 phase A and phase B exactly', () => {
  assert.deepEqual(DESKTOP_CONTROL_TOOLS.map((tool) => tool.name),
    ['request_app_access', 'list_windows', 'screenshot_window', 'read_ui', 'open_app',
      'click', 'invoke_element', 'type_text', 'key', 'scroll', 'clipboard_read', 'clipboard_write']);
  for (const tool of DESKTOP_CONTROL_TOOLS) assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  assert.deepEqual(DESKTOP_CONTROL_TOOLS[0]!.inputSchema.required, ['apps', 'reason']);
  const required = (name: string) => DESKTOP_CONTROL_TOOLS.find((tool) => tool.name === name)!.inputSchema.required;
  assert.deepEqual(required('click'), ['snapshotId', 'x', 'y']);
  assert.deepEqual(required('invoke_element'), ['elementId', 'action']);
  assert.deepEqual(required('type_text'), ['windowId', 'text']);
  assert.deepEqual(required('key'), ['windowId', 'keys']);
  assert.deepEqual(required('scroll'), ['snapshotId', 'x', 'y', 'direction', 'amount']);
  assert.deepEqual(required('clipboard_write'), ['text']);
  assert.equal(desktopToolInputSummary('mcp__cats-desktop__type_text'), 'Desktop control type_text input; its text is not kept.');
  assert.equal(desktopToolInputSummary('mcp__cats-desktop__clipboard_write'), 'Desktop control clipboard_write input; its text is not kept.');
  assert.equal(desktopToolInputSummary('mcp__cats-desktop__click'), null, 'other inputs carry no typed or clipboard text');
  assert.equal(DESKTOP_CONTROL_ERROR_CODES.length, 15);
  assert.equal(isDesktopControlToolName('mcp__cats-desktop__screenshot_window'), true);
  assert.equal(isDesktopControlToolName('cats_desktop.read_ui'), true);
  assert.equal(isDesktopControlToolName('mcp__cats-bot__ask_owner'), false);
  assert.equal(isDesktopControlToolName('mcp__cats-desktopish__x'), false);
  assert.match(desktopToolResultSummary('mcp__cats-desktop__read_ui'), /read_ui result; screen content is not kept/u);
});

test('the descriptor rides only qualifying sessions, stays stable, and tools serve only owner-present turns', async (t) => {
  const f = await fixture(t);
  const descriptor = await f.send();
  assert.ok(descriptor, 'a qualifying conversation carries cats-desktop');
  assert.equal(descriptor.name, 'cats-desktop');
  assert.match(descriptor.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/conv-1$/u);
  assert.deepEqual(await f.send(), descriptor, 'the descriptor is the same on every send (BDC-05)');

  // No turn, a background turn, an owner turn of another session: not owner-present.
  assert.equal(errorCode(await callDesktopTool(descriptor, 'list_windows')), 'not_owner_present');
  f.turn.current = background();
  assert.equal(errorCode(await callDesktopTool(descriptor, 'list_windows')), 'not_owner_present');
  f.turn.current = owner('session-0');
  assert.equal(errorCode(await callDesktopTool(descriptor, 'list_windows')), 'not_owner_present');
  f.turn.current = owner();
  const listed = await callDesktopTool(descriptor, 'list_windows');
  assert.equal(listed.isError, undefined);
  assert.deepEqual(listed.structuredContent, { windows: [] }, 'nothing is listed before a grant');

  // Another conversation's path with this token is refused.
  const other = await fetch(descriptor.url.replace(/conv-1$/u, 'conv-2'), { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${descriptor.auth.kind === 'bearer_env' ? descriptor.auth.token : ''}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(other.status, 401);

  // A new session gets a new token; the old one stops working.
  const moved = await f.send('conv-1', 'session-2');
  assert.notDeepEqual(moved, descriptor);
  await assert.rejects(callDesktopTool(descriptor, 'list_windows'), /HTTP 401/u);
  assert.deepEqual(f.service.descriptorFor('conv-1', 'session-1'), [], 'the old session no longer qualifies');

  // A conversation whose switch is off never qualifies.
  assert.equal(await f.send('conv-2', 'session-9'), undefined);
  assert.equal(f.service.capability('conv-2', 'session-9').reason, 'conversation_off');
});

test('the initialize answer names the server and its rules', async (t) => {
  const f = await fixture(t);
  const descriptor = (await f.send())!;
  const response = await fetch(descriptor.url, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${descriptor.auth.kind === 'bearer_env' ? descriptor.auth.token : ''}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) });
  const init = (await response.json()) as { result: { serverInfo: { name: string }; instructions: string } };
  assert.equal(init.result.serverInfo.name, 'cats-desktop');
  assert.match(init.result.instructions, /mcp__cats-desktop__request_app_access/u);
});

test('a session whose policy pre-approves tools, or has no snapshot, is never injected', async (t) => {
  const never = await fixture(t, { snapshot: snapshot({ approval: 'never' }) });
  assert.equal(await never.send(), undefined);
  assert.deepEqual(never.service.capability('conv-1', 'session-1'), { name: 'Cats desktop control', status: 'not_injected',
    reason: 'policy_preapproves_tools' });
  assert.equal(never.helper.spawned, 0, 'the helper does not start for a session that does not qualify');

  const missing = await fixture(t, { snapshot: null });
  assert.equal(await missing.send(), undefined);
  assert.equal(missing.service.capability('conv-1', 'session-1').reason, 'policy_unknown');

  // Qualifying once and then losing the policy drops the descriptor and revokes the token.
  const later = await fixture(t);
  const descriptor = await later.send();
  later.snapshotFor.current = snapshot({ status: 'mismatch' });
  assert.equal(await later.send(), undefined);
  await assert.rejects(callDesktopTool(descriptor, 'list_windows'), /HTTP 401/u);
});

test('only the owner grants apps; then list, screenshot, read and open work', async (t) => {
  const f = await fixture(t);
  const descriptor = await f.send();
  f.turn.current = owner();

  // No answer within the wait: the request stays open for the owner.
  const waited = await callDesktopTool(descriptor, 'request_app_access', { apps: ['記事本'], reason: 'Check the note' });
  assert.equal(waited.structuredContent.results[0].status, 'pending');
  assert.equal(f.service.pendingRequests('conv-1'), 1);
  assert.ok(f.changes.some((change) => change.notify && change.conversationId === 'conv-1'), 'a new request notifies');

  const pending = callDesktopTool(descriptor, 'request_app_access', { apps: ['記事本', 'cats', 'bot', 'nothing', 'powershell'],
    reason: 'Check the note' });
  await waitUntil(() => f.service.pendingRequests('conv-1') === 2, 5_000, 'second request');
  const open = f.service.state('conv-1', 'session-1').conversation!.pendingRequests;
  assert.equal(open.filter((row) => row.path === NOTEPAD).length, 1, 'asking again joins the open request');
  const notepad = open.find((row) => row.path === NOTEPAD)!;
  assert.equal(notepad.name, '記事本');
  assert.equal(f.service.decide('conv-2', notepad.requestId, 'allow'), false, 'another conversation cannot answer');
  assert.equal(f.service.decide('conv-1', notepad.requestId, 'allow'), true);
  assert.equal(f.service.decide('conv-1', notepad.requestId, 'allow'), false, 'a request is answered once');
  const powershell = f.service.state('conv-1', 'session-1').conversation!.pendingRequests[0]!;
  assert.equal(powershell.tier, 'observe_only');
  f.service.decide('conv-1', powershell.requestId, 'deny');
  const granted = (await pending).structuredContent.results as Array<{ status: string; app?: { appId?: string; tier: string } }>;
  assert.deepEqual(granted.map((row) => row.status), ['granted', 'excluded', 'excluded', 'not_found', 'denied'],
    'Cats Desktop (by file name) and the Bot itself are never grantable (BDC-08)');
  const appId = granted[0]!.app!.appId!;
  assert.match(appId, /^app_/u);

  const listed = (await callDesktopTool(descriptor, 'list_windows')).structuredContent.windows;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].appId, appId);
  assert.match(listed[0].windowId, /^win_/u);
  const shot = await callDesktopTool(descriptor, 'screenshot_window', { windowId: listed[0].windowId, maxEdge: 512 });
  assert.deepEqual(shot.content[0], { type: 'image', data: PNG_BYTES, mimeType: 'image/png' });
  assert.match(shot.structuredContent.snapshotId, /^snap_/u);
  assert.deepEqual(Object.keys(shot.structuredContent).sort(), ['capturedAt', 'height', 'scale', 'snapshotId', 'width', 'windowId']);
  const ui = (await callDesktopTool(descriptor, 'read_ui', { windowId: listed[0].windowId })).structuredContent;
  assert.deepEqual(ui.nodes.map((node: { elementId: string }) => node.elementId), ['ui1.e0', 'ui1.e1']);
  assert.equal(ui.nodes[1].parentId, 'ui1.e0');
  assert.equal(ui.truncated, false);
  assert.deepEqual((await callDesktopTool(descriptor, 'open_app', { appId })).structuredContent, { opened: true });
  assert.equal(errorCode(await callDesktopTool(descriptor, 'open_app', { appId: 'app_unknown' })), 'not_granted');
  assert.equal(errorCode(await callDesktopTool(descriptor, 'read_ui', { windowId: 'win_unknown' })), 'window_changed');
  assert.equal(errorCode(await callDesktopTool(descriptor, 'list_windows', { extra: 1 })), 'unavailable');
  assert.equal(errorCode(await callDesktopTool(descriptor, 'screenshot_window', { windowId: listed[0].windowId, maxEdge: 9 })),
    'unavailable');

  f.world.windows = [];
  assert.equal(errorCode(await callDesktopTool(descriptor, 'screenshot_window', { windowId: listed[0].windowId })),
    'window_changed', 'a closed or ungranted window is refused');

  const state = f.service.state('conv-1', 'session-1');
  assert.equal(state.conversation!.capability.status, 'active_turn');
  assert.deepEqual(state.conversation!.grants, [{ name: '記事本', path: NOTEPAD, publisher: 'Microsoft Corporation', tier: 'full' }]);
  const text = JSON.stringify(state) + f.logs.join('\n');
  for (const secret of [PNG_BYTES, SECRET_UI_VALUE, SECRET_TITLE]) {
    assert.equal(text.includes(secret), false, 'state and logs never carry screen content (BDC-12)');
  }

  f.turn.current = null;
  assert.equal(f.service.capability('conv-1', 'session-1').status, 'injected');
});

test('stop revokes grants and later calls return stopped until the owner grants again; a locked screen refuses', async (t) => {
  const f = await fixture(t);
  const descriptor = await f.send();
  f.turn.current = owner();
  const pending = callDesktopTool(descriptor, 'request_app_access', { apps: ['記事本'], reason: 'x' });
  await waitUntil(() => f.service.pendingRequests() === 1);
  f.service.decide('conv-1', f.service.state('conv-1').conversation!.pendingRequests[0]!.requestId, 'allow');
  await pending;

  f.service.stop('conv-1');
  assert.equal(errorCode(await callDesktopTool(descriptor, 'list_windows')), 'stopped');
  assert.equal(f.service.state('conv-1', 'session-1').conversation!.grants.length, 0);
  assert.equal(f.service.state('conv-1', 'session-1').conversation!.stopped, true);

  // A stop while the helper works discards its answer.
  const again = callDesktopTool(descriptor, 'request_app_access', { apps: ['記事本'], reason: 'again' });
  await waitUntil(() => f.service.pendingRequests() === 1);
  f.service.decide('conv-1', f.service.state('conv-1').conversation!.pendingRequests[0]!.requestId, 'allow');
  assert.equal((await again).structuredContent.results[0].status, 'granted');
  assert.equal(f.service.state('conv-1').conversation!.stopped, false, 'a new grant lifts the stop');
  f.world.holdOps = ['list_windows'];
  const inFlight = callDesktopTool(descriptor, 'list_windows');
  await waitUntil(() => f.helper.calls.filter((op) => op === 'list_windows').length > 0);
  f.service.stop();
  f.helper.release();
  assert.equal(errorCode(await inFlight), 'stopped');
  f.world.holdOps = [];

  // Stop also denies a waiting request.
  const waiting = callDesktopTool(descriptor, 'request_app_access', { apps: ['記事本'], reason: 'third' });
  await waitUntil(() => f.service.pendingRequests() === 1);
  f.service.stop('conv-1');
  assert.equal(f.service.pendingRequests(), 0);
  assert.equal(errorCode(await waiting), 'stopped');

  f.world.locked = true;
  assert.equal(errorCode(await callDesktopTool(descriptor, 'request_app_access', { apps: ['記事本'], reason: 'locked' })), 'locked');
});

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const SHELL_WINDOW = { hwnd: 9, pid: 2, path: POWERSHELL, title: 'PowerShell', bounds: { x: 0, y: 0, width: 400, height: 300 },
  minimized: false, foreground: false };

/** Asks for an app and allows it the way the owner would in the note; returns its appId. */
async function grant(f: Fixture, descriptor: Awaited<ReturnType<Fixture['send']>>, query: string): Promise<string> {
  const pending = callDesktopTool(descriptor, 'request_app_access', { apps: [query], reason: 'Test' });
  await waitUntil(() => f.service.pendingRequests('conv-1') > 0, 5_000, 'grant request');
  for (const request of f.service.state('conv-1').conversation!.pendingRequests) f.service.decide('conv-1', request.requestId, 'allow');
  return (await pending).structuredContent.results[0].app.appId as string;
}

test('phase B tools convert coordinates, keep the guards and hold control until the turn ends', async (t) => {
  const f = await fixture(t, { world: { windows: [...defaultWorld().windows, SHELL_WINDOW] } });
  const descriptor = await f.send();
  f.turn.current = owner();
  const sent = (op: string) => f.helper.requests.filter((row) => row.op === op).at(-1)?.params;
  const count = (op: string) => f.helper.requests.filter((row) => row.op === op).length;
  const code = async (name: string, args: Record<string, unknown>) => errorCode(await callDesktopTool(descriptor, name, args));
  await grant(f, descriptor, '記事本');
  await grant(f, descriptor, 'powershell');
  const windows = (await callDesktopTool(descriptor, 'list_windows')).structuredContent.windows;
  const notepad = windows.find((row: { title: string }) => row.title === SECRET_TITLE).windowId;
  const shell = windows.find((row: { title: string }) => row.title === 'PowerShell').windowId;
  const { snapshotId } = (await callDesktopTool(descriptor, 'screenshot_window', { windowId: notepad })).structuredContent;

  assert.equal(f.service.capability('conv-1', 'session-1').status, 'active_turn', 'observing holds nothing');
  assert.deepEqual((await callDesktopTool(descriptor, 'click', { snapshotId, x: 10, y: 20 })).structuredContent, { done: true });
  assert.deepEqual(sent('click'), { hwnd: 7, bounds: CAPTURE_BOUNDS, x: 120, y: 240, button: 'left', count: 1 },
    'image pixels become screen pixels through the snapshot scale, with the capture-time bounds');
  assert.equal(f.service.capability('conv-1', 'session-1').status, 'holding', 'holding takes precedence over active_turn');
  assert.deepEqual(f.service.state().holding, [{ conversationId: 'conv-1', app: '記事本' }]);
  assert.equal(f.service.state('conv-1', 'session-1').conversation!.holding, '記事本');
  assert.ok(f.changes.some((change) => change.conversationId === 'conv-1' && change.holding), 'the note and tray hear of it');

  assert.equal(await code('click', { snapshotId, x: 100, y: 0 }), 'stale_snapshot', 'a point outside the image');
  assert.equal(await code('click', { snapshotId: 'snap_unknown', x: 1, y: 1 }), 'stale_snapshot');
  await callDesktopTool(descriptor, 'scroll', { snapshotId, x: 0, y: 0, direction: 'down', amount: 3 });
  assert.deepEqual(sent('scroll'), { hwnd: 7, bounds: CAPTURE_BOUNDS, x: 100, y: 200, direction: 'down', amount: 3 });
  f.clock.now += 61_000;
  assert.equal(await code('click', { snapshotId, x: 1, y: 1 }), 'stale_snapshot', 'older than 60 seconds');

  const ui = (await callDesktopTool(descriptor, 'read_ui', { windowId: notepad })).structuredContent;
  await callDesktopTool(descriptor, 'invoke_element', { elementId: ui.nodes[1].elementId, action: 'toggle' });
  assert.deepEqual(sent('invoke'), { hwnd: 7, readId: 5, elementId: 'e1', action: 'toggle' }, 'element ids resolve to the helper read');
  assert.equal(await code('invoke_element', { elementId: 'ui99.e1', action: 'invoke' }), 'window_changed');

  await callDesktopTool(descriptor, 'type_text', { windowId: notepad, text: `${SECRET_TYPED} 喵` });
  assert.deepEqual(sent('type'), { hwnd: 7, text: `${SECRET_TYPED} 喵` });
  assert.equal(await code('type_text', { windowId: notepad, text: 'a\nb' }), 'unavailable', 'no control characters');
  f.world.fail = { type: 'password_field' };
  assert.equal(await code('type_text', { windowId: notepad, text: 'x' }), 'password_field', 'helper codes reach the model');
  f.world.fail = { key: 'covered' };
  assert.equal(await code('key', { windowId: notepad, keys: 'enter' }), 'covered');
  f.world.fail = {};
  await callDesktopTool(descriptor, 'key', { windowId: notepad, keys: 'Ctrl+S' });
  assert.deepEqual(sent('key'), { hwnd: 7, keys: 'ctrl+s' });
  assert.equal(await code('key', { windowId: notepad, keys: 'alt+tab' }), 'unavailable', 'keys outside the allowlist');

  // The parser says what each tool takes (same wording as Platform).
  const message = async (name: string, args: Record<string, unknown>) =>
    (await callDesktopTool(descriptor, name, args)).structuredContent.error.message as string;
  assert.equal(await message('type_text', { windowId: notepad, content: 'x' }),
    'Unexpected argument content; this tool takes only windowId, text.');
  assert.equal(await message('list_windows', { extra: 1 }), 'Unexpected argument extra; this tool takes only no arguments.');
  assert.equal(await message('click', { x: 1, y: 1 }), 'snapshotId is required and must be an id returned by a tool.');

  const shellShot = (await callDesktopTool(descriptor, 'screenshot_window', { windowId: shell })).structuredContent.snapshotId;
  assert.equal(await code('click', { snapshotId: shellShot, x: 1, y: 1 }), 'observe_only');
  assert.equal(await code('type_text', { windowId: shell, text: 'dir' }), 'observe_only');

  // Nothing reaches the helper when a check fails.
  const keys = count('key');
  f.world.operatorIdleMs = 1_000;
  assert.equal(await code('key', { windowId: notepad, keys: 'enter' }), 'operator_active');
  f.world.operatorIdleMs = 9_000;
  f.world.locked = true;
  assert.equal(await code('key', { windowId: notepad, keys: 'enter' }), 'locked');
  f.world.locked = false;
  f.turn.current = background();
  assert.equal(await code('key', { windowId: notepad, keys: 'enter' }), 'not_owner_present');
  f.turn.current = owner();
  assert.equal(count('key'), keys, 'nothing is sent while the owner is active, the screen is locked or the turn is not the owner\'s');

  await callDesktopTool(descriptor, 'clipboard_write', { text: SECRET_CLIPBOARD });
  assert.deepEqual((await callDesktopTool(descriptor, 'clipboard_read')).structuredContent, { text: SECRET_CLIPBOARD });
  const recorded = JSON.stringify(f.service.state('conv-1', 'session-1')) + JSON.stringify(f.changes) + f.logs.join('\n');
  for (const secret of [SECRET_TYPED, SECRET_CLIPBOARD]) assert.equal(recorded.includes(secret), false, 'state and logs never carry it (BDC-12)');

  // The end of the work item releases control; a later turn starts without it.
  f.service.turnEnded('conv-1', 'item-0');
  assert.equal(f.service.capability('conv-1', 'session-1').status, 'holding', 'another work item\'s end releases nothing');
  f.service.turnEnded('conv-1', 'item-1');
  f.turn.current = null;
  assert.equal(f.service.capability('conv-1', 'session-1').status, 'injected', 'the end of the turn releases control');
  assert.deepEqual(f.service.state().holding, []);
  assert.equal(f.changes.at(-1)!.holding, false);
  f.turn.current = owner('session-1', 'item-2');
  assert.equal((await callDesktopTool(descriptor, 'clipboard_read')).isError, undefined);
  assert.equal(f.service.capability('conv-1', 'session-1').status, 'active_turn', 'the clipboard holds no control');
  assert.equal(f.helper.calls.includes('cancel'), false, 'a normal end of a turn sends no cancel');
});

test('Stop cancels the helper op only for a conversation that holds control; later calls return stopped', async (t) => {
  const f = await fixture(t);
  const descriptor = await f.send();
  f.turn.current = owner();
  const cancels = () => f.helper.calls.filter((op) => op === 'cancel').length;
  await grant(f, descriptor, '記事本');
  const [window] = (await callDesktopTool(descriptor, 'list_windows')).structuredContent.windows;
  const { snapshotId } = (await callDesktopTool(descriptor, 'screenshot_window', { windowId: window.windowId })).structuredContent;
  f.service.stop('conv-2');
  f.service.stop();
  assert.equal(cancels(), 0, 'nothing held: stopping sends no cancel, so another conversation\'s input is never cut');
  assert.equal(errorCode(await callDesktopTool(descriptor, 'click', { snapshotId, x: 1, y: 1 })), 'stopped');

  await grant(f, descriptor, '記事本');
  const [again] = (await callDesktopTool(descriptor, 'list_windows')).structuredContent.windows;
  const shot = (await callDesktopTool(descriptor, 'screenshot_window', { windowId: again.windowId })).structuredContent.snapshotId;
  await callDesktopTool(descriptor, 'click', { snapshotId: shot, x: 1, y: 1 });
  f.service.stop('conv-2');
  assert.equal(cancels(), 0, 'stopping another conversation never cancels this one');

  f.world.holdOps = ['type'];
  const typing = callDesktopTool(descriptor, 'type_text', { windowId: again.windowId, text: 'a long text' });
  await waitUntil(() => f.helper.calls.includes('type'), 5_000, 'typing');
  f.service.stop('conv-1');
  await waitUntil(() => cancels() === 1, 5_000, 'cancel');
  f.helper.release();
  assert.equal(errorCode(await typing), 'stopped', 'Stop cancels the helper op in progress');
  f.world.holdOps = [];
  assert.deepEqual(f.service.state().holding, [], 'Stop releases control');
  assert.equal(f.service.capability('conv-1', 'session-1').status, 'active_turn');
  for (const [name, args] of [['click', { snapshotId: shot, x: 1, y: 1 }], ['type_text', { windowId: again.windowId, text: 'x' }],
    ['clipboard_read', {}]] as const) {
    assert.equal(errorCode(await callDesktopTool(descriptor, name, args)), 'stopped', `${name} after Stop`);
  }
  f.service.stop('conv-1');
  assert.equal(cancels(), 1, 'a conversation that no longer holds control sends no second cancel');

  // A turn that ends while its input still runs (the owner cancelled the turn) cancels that input too.
  await grant(f, descriptor, '記事本');
  const [third] = (await callDesktopTool(descriptor, 'list_windows')).structuredContent.windows;
  f.world.holdOps = ['type'];
  const cut = callDesktopTool(descriptor, 'type_text', { windowId: third.windowId, text: 'more text' });
  await waitUntil(() => f.helper.calls.filter((op) => op === 'type').length === 2, 5_000, 'second typing');
  f.service.turnEnded('conv-1', 'item-1');
  await waitUntil(() => cancels() === 2, 5_000, 'cancel at the end of the turn');
  assert.deepEqual(f.service.state().holding, [], 'the end of the turn releases control');
  f.helper.release();
  f.world.holdOps = [];
  await cut;

  // Turning the conversation off while it holds control also ends the input in progress.
  f.turn.current = owner('session-1', 'item-2');
  await callDesktopTool(descriptor, 'key', { windowId: third.windowId, keys: 'enter' });
  assert.equal(f.service.state().holding.length, 1);
  f.service.setConversation('conv-1', false);
  await waitUntil(() => cancels() === 3, 5_000, 'cancel on revoke');
  assert.deepEqual(f.service.state().holding, []);
});

test('grant requests join, expire unanswered and are limited to five per conversation', async (t) => {
  const many: FakeWorld['apps'] = {};
  for (let index = 0; index < 7; index += 1) {
    many[`app${index}`] = [{ path: `C:\\Apps\\app${index}.exe`, publisher: null, productName: `App ${index}`,
      displayName: `App ${index}`, running: true, category: 'normal', aumid: null }];
  }
  const f = await fixture(t, { world: { apps: many }, grantWaitMs: 50, requestTtlMs: 400 });
  const descriptor = await f.send();
  f.turn.current = owner();
  const first = await callDesktopTool(descriptor, 'request_app_access', { apps: ['app0', 'app1', 'app2', 'app3', 'app4'], reason: 'x' });
  assert.deepEqual(first.structuredContent.results.map((row: { status: string }) => row.status), Array(5).fill('pending'));
  const sixth = await callDesktopTool(descriptor, 'request_app_access', { apps: ['app5', 'app0'], reason: 'y' });
  assert.deepEqual(sixth.structuredContent.results.map((row: { status: string }) => row.status), ['denied', 'pending'],
    'a sixth app is denied, asking again for a waiting one joins it');
  assert.equal(f.service.pendingRequests('conv-1'), 5);
  await waitUntil(() => f.service.pendingRequests('conv-1') === 0, 5_000, 'expiry');
  assert.ok(f.changes.at(-1)!.pendingRequests === 0, 'expiry tells the core, which resumes held work');
});

test('a background turn cannot open a grant request', async (t) => {
  const f = await fixture(t);
  const descriptor = await f.send();
  f.turn.current = background();
  assert.equal(errorCode(await callDesktopTool(descriptor, 'request_app_access', { apps: ['記事本'], reason: 'x' })),
    'not_owner_present');
  assert.equal(f.service.pendingRequests(), 0, 'nothing waits, so nothing holds the gate');
  assert.equal(f.helper.calls.includes('resolve_apps'), false);
});

test('turning the feature or the conversation off revokes credentials, denies requests and ends the helper', async (t) => {
  const f = await fixture(t);
  const descriptor = await f.send();
  f.turn.current = owner();
  const waiting = callDesktopTool(descriptor, 'request_app_access', { apps: ['記事本'], reason: 'x' });
  await waitUntil(() => f.service.pendingRequests() === 1);
  f.service.setConversation('conv-1', false);
  assert.equal(f.service.pendingRequests(), 0);
  assert.equal(f.service.capability('conv-1', 'session-1').reason, 'conversation_off');
  await waiting.catch(() => undefined);
  await assert.rejects(callDesktopTool(descriptor, 'list_windows'), /HTTP 401/u);

  f.service.setConversation('conv-1', true);
  const again = await f.send();
  assert.ok(again);
  f.profile.enabled = false;
  f.service.profileChanged(false);
  await assert.rejects(callDesktopTool(again, 'list_windows'), /HTTP 401/u);
  assert.equal(f.service.capability('conv-1', 'session-1').status, 'off');
  assert.equal(await f.send(), undefined);
});

test('the helper never runs on other platforms or without its file', async (t) => {
  assert.deepEqual(resolveDesktopControlHelper({ platform: 'darwin' }), { path: null, unavailableReason: 'not_windows' });
  assert.deepEqual(resolveDesktopControlHelper({ platform: 'linux', helperPath: 'x.exe' }), { path: null, unavailableReason: 'not_windows' });
  assert.deepEqual(resolveDesktopControlHelper({ platform: 'win32', helperPath: null }), { path: null, unavailableReason: 'no_helper' });
  assert.deepEqual(resolveDesktopControlHelper({ platform: 'win32', helperPath: join(process.cwd(), 'missing.exe') }),
    { path: null, unavailableReason: 'helper_missing' });
  assert.match(packagedHelperPath('C:\\Bot\\resources'), /native[\\/]windows-desktop-control[\\/]cats-desktop-control-windows\.exe$/u);
  assert.match(developmentHelperPath(), /native[\\/]windows-desktop-control[\\/]bin[\\/]Release[\\/]net8\.0-windows10\.0\.19041\.0/u);

  const off = await fixture(t, { helper: null });
  assert.equal(await off.send(), undefined);
  const state = off.service.state('conv-1', 'session-1');
  assert.equal(state.available, false);
  assert.equal(state.reason, 'not_windows');
  assert.deepEqual(state.conversation!.capability, { name: 'Cats desktop control', status: 'unavailable', reason: 'not_windows' });
});

test('the helper client handshakes with the self lists, restarts after a crash and stops after repeated crashes', async () => {
  const world: FakeWorld = { apps: {}, windows: [], crashOn: 'list_windows' };
  const helper = fakeHelper(world);
  const client = createDesktopControlHelperClient({ path: 'fake.exe', selfProcessIds: [11], selfExecutables: ['C:\\Bot\\Cats Bot.exe'],
    spawn: helper.spawn });
  await client.handshake();
  assert.deepEqual(helper.hellos[0], { protocol: 1, selfProcessIds: [11], selfExecutables: ['C:\\Bot\\Cats Bot.exe'] });
  await client.handshake();
  assert.equal(helper.spawned, 1, 'a verified helper is not started again just to check it');
  for (let index = 0; index < 4; index += 1) {
    await assert.rejects(client.call('list_windows', { paths: [] }), (error: { code?: string }) => error.code === 'executor_failed');
  }
  assert.equal(client.unavailableReason(), 'helper_crashed');
  await assert.rejects(client.call('state'), (error: { code?: string }) => error.code === 'unavailable');
  assert.equal(helper.hellos.length, 4, 'each call after a crash starts a new helper');
  client.reset();
  assert.equal(client.unavailableReason(), null, 'turning the feature off and on clears the crash history');
  client.close();

  const mismatched = createDesktopControlHelperClient({ path: 'fake.exe', selfProcessIds: [], selfExecutables: [],
    spawn: fakeHelper({ protocol: 2, apps: {}, windows: [] }).spawn });
  await assert.rejects(mismatched.handshake(), (error: { code?: string }) => error.code === 'unavailable');
  assert.equal(mismatched.unavailableReason(), 'handshake_failed', 'a failed handshake keeps desktop control unavailable (BDC-01)');
  await assert.rejects(mismatched.call('state'), (error: { code?: string }) => error.code === 'unavailable');
  mismatched.close();
});
