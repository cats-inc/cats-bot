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
  desktopToolResultSummary,
  isDesktopControlToolName,
} from '../../src/core/desktopControl/tools.ts';
import type { SessionCapabilitiesSnapshot } from '../../src/core/types.ts';
import {
  callDesktopTool,
  defaultWorld,
  errorCode,
  fakeHelper,
  NOTEPAD,
  PNG_BYTES,
  SECRET_TITLE,
  SECRET_UI_VALUE,
  snapshot,
  waitUntil,
  type FakeWorld,
} from '../support/desktopControl.ts';
import { makeTempHome } from '../support/harness.ts';

/**
 * SPEC-006 phase A against a fake helper: the DC-04 policy gate, the descriptor and turn
 * rules (BDC-04, BDC-05), grants only the owner answers (BDC-07, SPEC-133 DC-08), the tools,
 * stop, lock, off and unavailable states, the helper's crash limit and the switch store.
 * These ports of Platform's desktop-control.test.js scenarios run the Bot's own code.
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
  });
  t.after(async () => {
    service.close();
    await service.stopServer();
    home.cleanup();
  });
  return {
    service, world, helper, switches, profile, turn, changes, logs, snapshotFor,
    async send(conversationId = 'conv-1', sessionId = 'session-1') {
      await service.refresh(conversationId, sessionId);
      return service.descriptorFor(conversationId, sessionId)[0];
    },
  };
}

const owner = (sessionId = 'session-1'): DesktopControlTurn => ({ sessionId, ownerPresent: true });

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

test('the tool list and error codes are SPEC-133 phase A exactly', () => {
  assert.deepEqual(DESKTOP_CONTROL_TOOLS.map((tool) => tool.name),
    ['request_app_access', 'list_windows', 'screenshot_window', 'read_ui', 'open_app']);
  for (const tool of DESKTOP_CONTROL_TOOLS) assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  assert.deepEqual(DESKTOP_CONTROL_TOOLS[0]!.inputSchema.required, ['apps', 'reason']);
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
  f.turn.current = { sessionId: 'session-1', ownerPresent: false };
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
  f.turn.current = { sessionId: 'session-1', ownerPresent: false };
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
