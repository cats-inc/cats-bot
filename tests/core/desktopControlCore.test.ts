import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';

import { BotCore, initializeBot } from '../../src/core/bot.ts';
import { callHostControl, HostControlRejectedError } from '../../src/core/host-api/control.ts';
import { createWorkItem } from '../../src/core/queue/workItems.ts';
import type { RuntimeClient, RuntimeMcpServer, RuntimeStreamEvent, SendMessageRequest } from '../../src/core/runtime/client.ts';
import type { BotHostEvent, DesktopControlState, SessionCapabilitiesSnapshot, WorkItem } from '../../src/core/types.ts';
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
  type McpToolResult,
} from '../support/desktopControl.ts';
import { makeTempHome } from '../support/harness.ts';

/**
 * SPEC-006 P2 in the Bot core, on a scripted in-process Runtime client and a fake helper:
 * injection decided per send (BDC-04), owner-present turns from the work item (BDC-05),
 * grants through BotHostApi only (BDC-07), the global gate while a grant waits (BDC-09),
 * the capability entry (BDC-13) and redaction (BDC-12). Covers B1–B3, B6 and B8 in code.
 */

interface Step {
  (context: { desktop: RuntimeMcpServer | undefined; emit(event: RuntimeStreamEvent): void; body: SendMessageRequest }): Promise<void>;
}

interface Harness {
  core: BotCore;
  root: string;
  world: FakeWorld;
  helper: ReturnType<typeof fakeHelper>;
  sends: Array<{ sessionId: string; body: SendMessageRequest }>;
  creates: Array<{ mcpServers?: RuntimeMcpServer[] }>;
  events: BotHostEvent[];
  logs: string[];
  telegram: string[];
  snapshotFor: { current: SessionCapabilitiesSnapshot };
  /** Runs `step` during the next turn the Runtime double streams. */
  during(step: Step): void;
  turn(text: string, source?: 'owner' | 'telegram', conversationId?: string): Promise<WorkItem>;
  background(kind: 'heartbeat' | 'schedule', conversationId?: string): Promise<WorkItem>;
  completed(id: string): Promise<WorkItem>;
}

async function harness(t: TestContext, options: { platform?: NodeJS.Platform; helperPath?: string | null; grantWaitMs?: number } = {}): Promise<Harness> {
  const home = makeTempHome('cats-desktop-core-');
  const { root } = initializeBot(home.botsHome, { id: 'desk', name: 'Desk', provider: 'claude' });
  const world = defaultWorld();
  const helper = fakeHelper(world);
  const sends: Harness['sends'] = [];
  const creates: Harness['creates'] = [];
  const sessions = new Map<string, RuntimeMcpServer[]>();
  const steps: Step[] = [];
  const stepErrors: unknown[] = [];
  const snapshotFor = { current: snapshot() };
  let sessionCount = 0;
  const client = {
    async sessionControls() { return {}; },
    async createSession(request: { mcpServers?: RuntimeMcpServer[] }) {
      creates.push({ ...(request.mcpServers ? { mcpServers: request.mcpServers } : {}) });
      const id = `session-${(sessionCount += 1)}`;
      sessions.set(id, request.mcpServers ?? []);
      return { id, status: 'ready' };
    },
    async resumeSession(id: string, body: { mcpServers?: RuntimeMcpServer[] } = {}) {
      if (body.mcpServers) sessions.set(id, body.mcpServers);
      return { id, status: 'ready' };
    },
    async getSession(id: string) { return { id, status: 'ready' }; },
    async getHistory() { return { messages: [] }; },
    async capabilities(id: string) { return { ...snapshotFor.current, sessionId: id }; },
    async interactions(id: string) { return { version: 1, sessionId: id, workerGeneration: null, revision: 0, interactions: [] }; },
    async closeSession(id: string) { return { id, status: 'closed' }; },
    async cancelSession(id: string) { return { id, status: 'ready' }; },
    async deleteSession() { return {}; },
    async streamMessage(sessionId: string, body: SendMessageRequest, onEvent: (event: RuntimeStreamEvent) => void) {
      sends.push({ sessionId, body });
      // SPEC-035: an omitted set keeps the session's set; a given set replaces it.
      if (body.mcpServers) sessions.set(sessionId, body.mcpServers);
      const desktop = sessions.get(sessionId)?.find((server) => server.name === 'cats-desktop');
      const step = steps.shift();
      if (step) {
        try {
          await step({ desktop, emit: onEvent, body });
        } catch (error) {
          stepErrors.push(error);
          throw error;
        }
      }
      onEvent({ type: 'text', text: 'done' });
      onEvent({ type: 'result' });
      return { completed: true, eventCount: 2, resultEvent: { type: 'result' }, errorText: null };
    },
  } as unknown as RuntimeClient;
  const logs: string[] = [];
  const core = BotCore.open({
    root,
    runtimeClient: client,
    tools: false,
    log: (line) => logs.push(line),
    handoffPollMs: 3_600_000,
    life: { startupDelayMs: 3_600_000, intervalMs: 3_600_000 },
    desktopControl: {
      platform: options.platform ?? 'win32',
      ...(options.helperPath !== undefined ? { helperPath: options.helperPath } : { helperPath: 'fake.exe' }),
      spawn: helper.spawn,
      grantWaitMs: options.grantWaitMs ?? 200,
    },
  });
  const events: BotHostEvent[] = [];
  core.subscribe((event) => events.push(event));
  const telegram: string[] = [];
  await core.start();
  // A stand-in for the Telegram transport: only what the core sends is recorded.
  (core as unknown as { telegram: unknown }).telegram = {
    send: async (text: string) => { telegram.push(text); },
    stop: async () => {},
    status: () => ({ polling: true }),
  };
  t.after(async () => {
    (core as unknown as { telegram: unknown }).telegram = null;
    await core.stop();
    home.cleanup();
  });
  // An assertion inside a step fails the turn; it is rethrown here so it fails the test.
  const completed = (id: string) => new Promise<WorkItem>((resolve, reject) => {
    const settle = (item: WorkItem) => (stepErrors.length ? reject(stepErrors.shift()) : resolve(item));
    const done = core.getWorkItem(id);
    if (done && ['completed', 'failed', 'cancelled', 'interrupted'].includes(done.state)) { settle(done); return; }
    const off = core.subscribe((event) => {
      if (event.type === 'turn.completed' && event.workItem.id === id) { off(); settle(event.workItem); }
    });
  });
  return {
    core, root, world, helper, sends, creates, events, logs, telegram, snapshotFor,
    during(step) { steps.push(step); },
    async turn(text, source = 'owner', conversationId = 'home') {
      const item = await core.sendOwnerMessage(conversationId, text, source);
      return completed(item.id);
    },
    async background(kind, conversationId = 'home') {
      const home = (await core.listConversations()).find((row) => row.role === 'home')!;
      const item = core.enqueueWorkItem(createWorkItem({ kind, source: kind === 'schedule' ? 'sch-test' : 'heartbeat:regular',
        conversationId: conversationId === 'home' ? home.id : conversationId, prompt: `${kind} prompt` }, new Date()));
      return item;
    },
    completed,
  };
}

async function enable(h: Harness, conversationId = 'home'): Promise<void> {
  await h.core.updateProfile({ desktopControl: { enabled: true } });
  await h.core.setConversationDesktopControl(conversationId, true);
}

async function grantNotepad(h: Harness, desktop: RuntimeMcpServer | undefined, conversationId = 'home'): Promise<string> {
  const pending = callDesktopTool(desktop, 'request_app_access', { apps: ['記事本'], reason: 'Read the note' });
  await waitUntil(() => h.core.status().queue.running !== null);
  let requestId: string | undefined;
  await waitUntil(() => {
    void h.core.desktopControlState(conversationId).then((state) => { requestId = state.conversation?.pendingRequests[0]?.requestId; });
    return requestId !== undefined;
  }, 5_000, 'grant request');
  await h.core.respondDesktopGrant(conversationId, requestId!, 'allow');
  const result = await pending;
  return result.structuredContent.results[0].app.appId as string;
}

test('B1: off by default, and unavailable off Windows or without the helper; nothing is injected', async (t) => {
  const h = await harness(t);
  const profile = await h.core.getProfile();
  assert.deepEqual(profile.desktopControl, { enabled: false });
  await h.turn('hello');
  assert.equal(h.sends[0]!.body.mcpServers, undefined, 'a Bot without desktop control sends exactly what it sent before');
  const capabilities = await h.core.sessionCapabilities('home');
  assert.deepEqual(capabilities.desktopControl, { name: 'Cats desktop control', status: 'off', reason: 'off' });
  assert.equal(capabilities.observation?.dependencies[0]?.kind, 'computer_use', 'provider computer use stays separate (BDC-13)');
  assert.equal(h.helper.spawned, 0);
  const listener = () => (h.core as unknown as { desktop: { server: { url: string | null } | null } }).desktop.server?.url ?? null;
  assert.equal(listener(), null, 'no cats-desktop listener opens while the feature is off');
  await enable(h);
  await h.turn('now on');
  assert.match(listener() ?? '', /^http:\/\/127\.0\.0\.1:\d+\/mcp$/u, 'the first qualifying send opens it');

  for (const [platform, helperPath, reason] of [['linux', 'fake.exe', 'not_windows'], ['darwin', 'fake.exe', 'not_windows'],
    ['win32', null, 'no_helper']] as const) {
    const other = await harness(t, { platform, helperPath });
    await enable(other);
    await other.turn('hello');
    assert.equal(other.sends[0]!.body.mcpServers?.some((server) => server.name === 'cats-desktop') ?? false, false);
    const state = await other.core.desktopControlState('home');
    assert.equal(state.available, false);
    assert.equal(state.reason, reason);
    assert.deepEqual((await other.core.sessionCapabilities('home')).desktopControl,
      { name: 'Cats desktop control', status: 'unavailable', reason });
    assert.equal(other.helper.spawned, 0);
  }

  const failed = await harness(t);
  failed.world.protocol = 2;
  await enable(failed);
  await failed.turn('hello');
  assert.equal(failed.sends[0]!.body.mcpServers?.some((server) => server.name === 'cats-desktop'), false,
    'a failed handshake injects nothing');
  assert.equal((await failed.core.desktopControlState()).reason, 'handshake_failed');
});

test('B2: injection matrix, a stable descriptor, and owner-present only for owner messages from a local surface', async (t) => {
  const h = await harness(t);
  await h.core.updateProfile({ desktopControl: { enabled: true } });
  assert.equal((await h.core.getProfile()).configRevision, 1, 'the profile switch is not a session setting');
  await h.turn('conversation still off');
  assert.deepEqual(h.sends[0]!.body.mcpServers, [], 'with the feature on, the explicit set omits cats-desktop');
  assert.deepEqual(h.creates[0], { mcpServers: [] }, 'a new session never starts with cats-desktop');

  await h.core.setConversationDesktopControl('home', true);
  const codes: Record<string, string | undefined> = {};
  let descriptor: RuntimeMcpServer | undefined;
  h.during(async ({ desktop, body }) => {
    descriptor = desktop;
    assert.ok(body.mcpServers?.some((server) => server.name === 'cats-desktop'), 'the send that qualifies carries the set');
    assert.equal(body.instructions, undefined, 'turn instructions would replace the Bot\'s own');
    codes.owner = errorCode(await callDesktopTool(desktop, 'list_windows'));
    const capability = (await h.core.sessionCapabilities('home')).desktopControl;
    codes.capability = capability?.status;
  });
  await h.turn('look at my screen');
  assert.ok(descriptor);
  assert.equal(codes.owner, undefined, 'an owner message from the note or cats-bot say can use the tools');
  assert.equal(codes.capability, 'active_turn');
  assert.equal((await h.core.sessionCapabilities('home')).desktopControl?.status, 'injected');

  h.during(async ({ desktop }) => { codes.telegram = errorCode(await callDesktopTool(desktop, 'list_windows')); });
  await h.turn('from my phone', 'telegram');
  h.during(async ({ desktop }) => { codes.heartbeat = errorCode(await callDesktopTool(desktop, 'list_windows')); });
  await h.completed((await h.background('heartbeat')).id);
  h.during(async ({ desktop }) => { codes.schedule = errorCode(await callDesktopTool(desktop, 'request_app_access', { apps: ['記事本'], reason: 'x' })); });
  await h.completed((await h.background('schedule')).id);
  assert.deepEqual([codes.telegram, codes.heartbeat, codes.schedule], ['not_owner_present', 'not_owner_present', 'not_owner_present']);
  assert.equal((await h.core.desktopControlState()).pendingRequests, 0, 'a background turn opened no grant request');
  assert.equal(errorCode(await callDesktopTool(descriptor, 'list_windows')), 'not_owner_present', 'no turn runs');

  const qualifying = h.sends.slice(1).map((send) => send.body.mcpServers?.find((server) => server.name === 'cats-desktop'));
  assert.ok(qualifying.every((server) => JSON.stringify(server) === JSON.stringify(descriptor)),
    'every send of the conversation carries the same descriptor, whatever the turn (BDC-05)');

  h.snapshotFor.current = snapshot({ approval: 'never' });
  await h.turn('policy changed');
  assert.equal(h.sends.at(-1)!.body.mcpServers?.some((server) => server.name === 'cats-desktop'), false,
    'a policy that pre-approves tools drops the descriptor');
  await assert.rejects(callDesktopTool(descriptor, 'list_windows'), /HTTP 401/u);
  assert.deepEqual((await h.core.sessionCapabilities('home')).desktopControl,
    { name: 'Cats desktop control', status: 'not_injected', reason: 'policy_preapproves_tools' });
});

test('B3: grants only through BotHostApi; cleared by stop, switching off and core restart', async (t) => {
  const h = await harness(t);
  await enable(h);
  const note = await h.core.createConversation('Other');
  let appId = '';
  let desktop: RuntimeMcpServer | undefined;
  h.during(async (context) => {
    desktop = context.desktop;
    const pending = callDesktopTool(context.desktop, 'request_app_access', { apps: ['記事本', 'cats'], reason: 'Read the note' });
    let requestId: string | undefined;
    await waitUntil(() => {
      void h.core.desktopControlState('home').then((state) => { requestId = state.conversation?.pendingRequests[0]?.requestId; });
      return requestId !== undefined;
    });
    await assert.rejects(h.core.respondDesktopGrant(note.id, requestId!, 'allow'), /No desktop control grant request/u);
    await assert.rejects(h.core.respondDesktopGrant('home', requestId!, 'yes' as 'allow'), /allow or deny/u);
    await assert.rejects(h.core.resolveApproval(requestId!, 'approve'), /Unknown work item/u, 'resolveApproval cannot answer a grant');
    await assert.rejects(h.core.respondProviderInteraction('home', requestId!, {} as never), 'nor can a provider interaction answer');
    await h.core.respondDesktopGrant('home', requestId!, 'allow');
    const results = (await pending).structuredContent.results;
    assert.deepEqual(results.map((row: { status: string }) => row.status), ['granted', 'excluded']);
    appId = results[0].app.appId;
    assert.equal(errorCode(await callDesktopTool(context.desktop, 'open_app', { appId })), undefined);
  });
  await h.turn('open notepad');
  assert.ok(appId);
  assert.equal((await h.core.desktopControlState('home')).conversation!.grants.length, 1);

  await h.core.stopDesktopControl('home');
  assert.equal((await h.core.desktopControlState('home')).conversation!.grants.length, 0, 'stop clears grants');
  h.during(async (context) => {
    assert.equal(errorCode(await callDesktopTool(context.desktop, 'list_windows')), 'stopped');
    await grantNotepad(h, context.desktop);
  });
  await h.turn('again');
  assert.equal((await h.core.desktopControlState('home')).conversation!.grants.length, 1);

  await h.core.setConversationDesktopControl('home', false);
  assert.equal((await h.core.desktopControlState('home')).conversation!.grants.length, 0, 'switching off clears grants');
  await assert.rejects(callDesktopTool(desktop, 'list_windows'), /HTTP 401/u);
  assert.deepEqual(JSON.parse(readFileSync(join(h.root, 'desktop-control.json'), 'utf8')), { version: 1, conversations: [] });

  await h.core.setConversationDesktopControl('home', true);
  h.during(async (context) => { await grantNotepad(h, context.desktop); });
  await h.turn('third');
  assert.equal((await h.core.desktopControlState('home')).conversation!.grants.length, 1);
  await h.core.updateProfile({ desktopControl: { enabled: false } });
  assert.equal((await h.core.desktopControlState('home')).conversation!.grants.length, 0, 'the profile switch clears grants');

  // Grants live in memory only: a restarted core has none, while the switches persist.
  await h.core.updateProfile({ desktopControl: { enabled: true } });
  h.during(async (context) => { await grantNotepad(h, context.desktop); });
  await h.turn('fourth');
  await h.core.stop();
  const reopened = BotCore.open({ root: h.root, runtimeClient: (h.core as unknown as { options: { runtimeClient: RuntimeClient } }).options.runtimeClient,
    tools: false, log: () => {}, handoffPollMs: 3_600_000, life: { startupDelayMs: 3_600_000, intervalMs: 3_600_000 },
    desktopControl: { platform: 'win32', helperPath: 'fake.exe', spawn: h.helper.spawn } });
  await reopened.start();
  try {
    const state = await reopened.desktopControlState('home');
    assert.equal(state.enabled, true);
    assert.deepEqual(state.conversations.length, 1);
    assert.equal(state.conversation!.grants.length, 0);
  } finally { await reopened.stop(); }
});

test('B6: a waiting grant holds background work, owner messages still run, and work resumes once it is answered', async (t) => {
  const h = await harness(t, { grantWaitMs: 50 });
  await enable(h);
  let result: McpToolResult | undefined;
  h.during(async ({ desktop }) => { result = await callDesktopTool(desktop, 'request_app_access', { apps: ['記事本'], reason: 'x' }); });
  await h.turn('ask for notepad');
  assert.equal(result!.structuredContent.results[0].status, 'pending', 'the turn ended while the owner had not answered');
  assert.equal((await h.core.desktopControlState()).pendingRequests, 1);

  const schedule = await h.background('schedule');
  const heartbeat = await h.background('heartbeat');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(h.core.getWorkItem(schedule.id)?.state, 'queued', 'background work cannot take over the waiting session');
  assert.equal(h.core.getWorkItem(heartbeat.id)?.state, 'queued');
  assert.equal(h.core.status().queue.running, null);

  const owner = await h.turn('owner keeps talking');
  assert.equal(owner.state, 'completed', 'owner messages are not held');
  assert.equal(h.core.getWorkItem(schedule.id)?.state, 'queued');

  const requestId = (await h.core.desktopControlState('home')).conversation!.pendingRequests[0]!.requestId;
  const resumed = h.completed(schedule.id);
  await h.core.respondDesktopGrant('home', requestId, 'deny');
  assert.equal((await resumed).state, 'completed', 'background work resumes after the answer');
  assert.equal((await h.completed(heartbeat.id)).state, 'completed');
});

test('B8: screenshots, UI values and window titles reach no transcript, journal, log or Telegram notice', async (t) => {
  const h = await harness(t, { grantWaitMs: 50 });
  await enable(h);
  // Telegram learns only that something waits.
  h.during(async ({ desktop }) => { await callDesktopTool(desktop, 'request_app_access', { apps: ['記事本'], reason: 'look at the secret note' }); });
  await h.turn('ask');
  const notices = h.telegram.filter((text) => /desktop control/iu.test(text));
  assert.equal(notices.length, 1, 'one notice per new request; the reply itself is mirrored as before');
  assert.match(notices[0]!, /desktop control request is waiting/u);
  for (const leak of ['記事本', 'Notepad', NOTEPAD, 'secret note', 'grant_']) assert.equal(notices[0]!.includes(leak), false, leak);
  assert.ok(h.events.some((event) => event.type === 'desktop.control' && event.notify === true && event.pendingRequests === 1));
  // A Telegram message is an owner message, but it answers nothing.
  await h.turn('allow', 'telegram');
  assert.equal((await h.core.desktopControlState()).pendingRequests, 1);
  const requestId = (await h.core.desktopControlState('home')).conversation!.pendingRequests[0]!.requestId;
  await h.core.respondDesktopGrant('home', requestId, 'allow');
  await h.turn('granted now');

  h.during(async ({ desktop, emit }) => {
    const windows = (await callDesktopTool(desktop, 'list_windows')).structuredContent.windows;
    assert.equal(windows[0].title, SECRET_TITLE, 'the model sees the title');
    const shot = await callDesktopTool(desktop, 'screenshot_window', { windowId: windows[0].windowId });
    const ui = await callDesktopTool(desktop, 'read_ui', { windowId: windows[0].windowId });
    // What Runtime reports for Claude Code: the tool_result carries the stringified MCP content.
    emit({ type: 'tool_use', toolName: 'mcp__cats-desktop__screenshot_window', toolId: 't1', toolArgs: { windowId: windows[0].windowId } });
    emit({ type: 'tool_result', toolId: 't1', text: JSON.stringify(shot.content) });
    emit({ type: 'tool_use', toolName: 'mcp__cats-desktop__read_ui', toolId: 't2', toolArgs: { windowId: windows[0].windowId } });
    emit({ type: 'tool_result', toolId: 't2', text: JSON.stringify(ui.structuredContent) });
    emit({ type: 'tool_use', toolName: 'mcp__cats-desktop__list_windows', toolId: 't3', toolArgs: {} });
    emit({ type: 'tool_result', toolId: 't3', text: JSON.stringify(windows) });
    emit({ type: 'tool_use', toolName: 'mcp__cats-desktop__read_ui', toolId: 't4', toolArgs: { windowId: 'win_x' } });
    emit({ type: 'tool_result', toolId: 't4', isError: true, text: 'window_changed: Unknown windowId; call list_windows again.' });
  });
  await h.turn('describe my screen');

  const transcript = JSON.stringify(h.core.transcript('home'));
  assert.match(transcript, /Desktop control screenshot_window result; screen content is not kept/u);
  assert.match(transcript, /window_changed: Unknown windowId/u, 'an error stays readable');
  const deltas = JSON.stringify(h.events.filter((event) => event.type === 'turn.delta'));
  const files = ['journal.jsonl', 'desktop-control.json', 'profile.json', ...readdirSync(join(h.root, 'logs')).map((file) => join('logs', file)),
    ...readdirSync(join(h.root, 'transcripts')).map((file) => join('transcripts', file))]
    .map((file) => { try { return readFileSync(join(h.root, file), 'utf8'); } catch { return ''; } }).join('\n');
  for (const [label, text] of [['transcript', transcript], ['turn deltas', deltas], ['files', files],
    ['logs', h.logs.join('\n')], ['telegram', h.telegram.join('\n')]] as const) {
    for (const secret of [PNG_BYTES, SECRET_UI_VALUE, SECRET_TITLE]) assert.equal(text.includes(secret), false, `${label} leaked ${secret.slice(0, 12)}`);
  }
  for (const send of h.sends) {
    const token = send.body.mcpServers?.find((server) => server.name === 'cats-desktop')?.auth;
    if (token?.kind === 'bearer_env') assert.equal(files.includes(token.token) || h.logs.join('\n').includes(token.token), false,
      'the bearer token is never written (BDC-06)');
  }
});

test('deleting a conversation forgets its switch and grants; a recovery rerun is not owner-present', async (t) => {
  const h = await harness(t);
  await h.core.updateProfile({ desktopControl: { enabled: true } });
  const note = await h.core.createConversation('Desk');
  await h.core.setConversationDesktopControl(note.id, true);
  h.during(async ({ desktop }) => { assert.equal(errorCode(await callDesktopTool(desktop, 'list_windows')), undefined); });
  await h.turn('look', 'owner', note.id);
  await h.core.deleteConversation(note.id);
  assert.deepEqual((await h.core.desktopControlState()).conversations, []);

  await h.core.setConversationDesktopControl('home', true);
  let code: string | undefined = 'unset';
  h.during(async ({ desktop }) => { code = errorCode(await callDesktopTool(desktop, 'list_windows')); });
  const rerun = await h.core.sendOwnerMessage('home', 'interrupted prompt', 'recovery');
  await h.completed(rerun.id);
  assert.equal(code, 'not_owner_present');
});

/** `cats-bot … --id desk` against the harness's running core, the way the owner runs it. */
function cli(root: string, ...args: string[]): Promise<{ code: number | null; out: string; error: string }> {
  return new Promise((resolveResult, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, CATS_BOTS_HOME: dirname(root) };
    delete env.CATS_BOT_ID;
    const child = spawn(process.execPath, [resolve('src/cli/main.ts'), ...args, '--id', 'desk'], {
      env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    let error = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { error += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => resolveResult({ code, out, error }));
  });
}

test('P3: cats-bot desktop and the control endpoint show state, set the switch, answer a grant and stop', async (t) => {
  const h = await harness(t, { grantWaitMs: 50 });
  const note = await h.core.createConversation('Desk');
  const control = (body: Record<string, unknown>) => callHostControl(h.root, body) as Promise<DesktopControlState>;

  // The profile switch is off: the conversation switch is stored, and the owner is told why nothing happens yet.
  const early = await cli(h.root, 'desktop', '--enable', note.id);
  assert.equal(early.code, 0, early.error);
  assert.equal((JSON.parse(early.out) as DesktopControlState).conversation?.conversationId, note.id, '--enable <conversation> names it');
  assert.match(early.error, /profile switch is off/u);
  await h.core.updateProfile({ desktopControl: { enabled: true } });
  const enabled = await control({ operation: 'desktop_switch', conversationId: 'home', enabled: true });
  assert.deepEqual([enabled.enabled, enabled.conversation?.enabled, [...enabled.conversations].sort()], [true, true, ['home', note.id].sort()]);
  await assert.rejects(control({ operation: 'desktop_switch', conversationId: 'home', enabled: 'yes' }), HostControlRejectedError);

  h.during(async ({ desktop }) => { await callDesktopTool(desktop, 'request_app_access', { apps: ['記事本'], reason: 'Read the note' }); });
  await h.turn('ask for notepad');
  const state = await cli(h.root, 'desktop', 'home');
  assert.equal(state.code, 0, state.error);
  const waiting = JSON.parse(state.out) as DesktopControlState;
  const request = waiting.conversation!.pendingRequests[0]!;
  assert.equal(waiting.pendingRequests, 1);
  assert.deepEqual({ name: request.name, path: request.path, publisher: request.publisher, tier: request.tier, reason: request.reason },
    { name: '記事本', path: NOTEPAD, publisher: 'Microsoft Corporation', tier: 'full', reason: 'Read the note' });

  // Only `desktop_grant` answers it: not the provider path, not another conversation, not a word other than allow|deny.
  await assert.rejects(control({ operation: 'respond', conversationId: 'home', interactionId: request.requestId,
    response: { answer: { action: 'accept' } } }), HostControlRejectedError);
  await assert.rejects(control({ operation: 'desktop_grant', conversationId: note.id, requestId: request.requestId, decision: 'allow' }),
    HostControlRejectedError);
  await assert.rejects(control({ operation: 'desktop_grant', conversationId: 'home', requestId: request.requestId, decision: 'approve' }),
    HostControlRejectedError);
  const usage = await cli(h.root, 'desktop', 'home', '--grant', request.requestId, 'yes');
  assert.equal(usage.code, 2);
  const unknown = await cli(h.root, 'desktop', 'home', '--grant', 'grant_unknown', 'allow');
  assert.equal(unknown.code, 1);
  assert.match(unknown.error, /No grant request grant_unknown waits in home/u);
  assert.equal((await h.core.desktopControlState()).pendingRequests, 1, 'still waiting');

  const granted = await cli(h.root, 'desktop', 'home', '--grant', request.requestId, 'allow');
  assert.equal(granted.code, 0, granted.error);
  const after = JSON.parse(granted.out) as DesktopControlState;
  assert.deepEqual(after.conversation?.grants.map((app) => app.name), ['記事本']);
  assert.deepEqual(after.conversation?.pendingRequests, []);
  // PLAN-006 P3: `cats-bot capabilities` prints the Bot's own entry beside Runtime's observation.
  const capabilities = await callHostControl(h.root, { operation: 'capabilities', conversationId: 'home' }) as SessionCapabilitiesSnapshot;
  assert.deepEqual(capabilities.desktopControl, { name: 'Cats desktop control', status: 'injected', reason: null });

  // `--stop --all` is the tray's stop: every conversation, grants revoked.
  await assert.rejects(control({ operation: 'desktop_stop' }), HostControlRejectedError, 'a stop names a conversation or all');
  const stopped = await cli(h.root, 'desktop', '--stop', '--all');
  assert.equal(stopped.code, 0, stopped.error);
  assert.equal((JSON.parse(stopped.out) as DesktopControlState).conversation, undefined);
  const home = (await h.core.desktopControlState('home')).conversation!;
  assert.deepEqual([home.grants.length, home.stopped], [0, true]);

  const disabled = await control({ operation: 'desktop_switch', conversationId: 'home', enabled: false });
  assert.equal(disabled.conversation?.enabled, false);
  assert.equal((await cli(h.root, 'desktop', 'home', '--enable', '--disable')).code, 2, 'one action at a time');
  assert.ok(h.events.some((event) => event.type === 'desktop.control' && event.notify === true), 'the shell bubble and tray follow this event');
});

test('P3: cats-bot desktop needs the running bot, except for a stop', async () => {
  const home = makeTempHome('cats-desktop-cli-');
  try {
    const { root } = initializeBot(home.botsHome, { id: 'desk', name: 'Desk', provider: 'claude' });
    const state = await cli(root, 'desktop', 'home');
    assert.equal(state.code, 1);
    assert.match(state.error, /Start the bot before using desktop control/u);
    const stop = await cli(root, 'desktop', '--stop');
    assert.equal(stop.code, 0, stop.error);
    assert.match(stop.out, /desktop control is not active/u);
  } finally { home.cleanup(); }
});
