// Scripted MSP/ACP peer for the packed Runtime consumer test, never a real provider.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const provider = process.argv[2];
const muse = provider === 'muse';
let sessionId;
let servers = [];
let turn = 0;
let pending;
const write = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const reply = (id, result) => write({ id, result });
const notify = (method, params) => write({ method, params: { sessionId, ...params } });
const update = value => notify('session/update', { update: value });
const audit = value => {
  if (process.env.CATS_HOSTED_FIXTURE_LOG) appendFileSync(process.env.CATS_HOSTED_FIXTURE_LOG, JSON.stringify(value) + '\n');
};

async function mcp(server, method, params = {}) {
  const response = await fetch(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream', ...server.headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!response.ok) throw new Error(`MCP ${response.status}`);
  const frame = await response.json();
  if (frame.error) throw new Error('MCP rejected fixture');
  return frame.result;
}

async function runTurn(request, nativeTurn) {
  const prompt = muse ? request.params.input.map(item => item.text ?? '').join('\n')
    : request.params.prompt.map(item => item.text ?? '').join('\n');
  audit({ event: 'turn', sessionId, prompt });
  let text = 'native tools enabled';
  if (prompt.includes('fixture:hold')) return;
  if (prompt.includes('fixture:tools')) {
    const server = servers.find(server => server.name === 'cats-bot');
    const result = await mcp(server, 'tools/call', { name: 'schedule_list', arguments: {} });
    text = `Cats tool replied: ${result.content[0].text}`;
  }
  if (prompt.includes('fixture:approval')) {
    const response = new Promise(resolve => { pending = resolve; });
    if (muse) write({ id: 700, method: 'approval/request', params: { sessionId, turnId: nativeTurn, approvalId: 'approval',
      currentRequirementId: { approvalId: 'approval', sourceIndex: 0 }, toolName: 'shell',
      subject: { kind: 'shell', command: 'printf fixture' }, availableChoices: [
        { choiceId: 'allow', label: 'Allow once', decision: 'approved', scope: 'once' },
        { choiceId: 'deny', label: 'Deny', decision: 'denied', scope: 'once' }] } });
    else write({ id: 700, method: 'session/request_permission', params: { sessionId,
      toolCall: { toolCallId: 'tool', kind: 'execute', title: 'Run fixture', rawInput: { command: 'printf fixture' } },
      options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] } });
    const answer = await response;
    text = answer === 'allow' ? 'native approval accepted' : 'native approval denied';
    if (muse) notify('approval/resolved', { approvalId: 'approval' });
    else update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed' });
  }
  if (muse) {
    notify('item/completed', { item: { itemId: `message-${turn}`, turnId: nativeTurn, kind: 'agentMessage', text } });
    notify('turn/completed', { turnId: nativeTurn, terminal: 'completed' });
  } else {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    reply(request.id, { stopReason: 'end_turn' });
  }
}

async function handle(request) {
  if (!request.method) {
    if (!muse && request.id === 700) { pending?.(request.result?.outcome?.optionId); pending = null; }
    return;
  }
  const params = request.params ?? {};
  switch (request.method) {
    case 'initialize':
      return reply(request.id, muse ? { experimentalApi: true, grantedCapabilities: ['sessionMcp'], sandboxAvailability: 'available' }
        : { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true }, sessionCapabilities: { resume: {} } },
          _meta: { mcpServers: [] } });
    case 'initialized': return;
    case 'permissionProfile/list': return reply(request.id, { profiles: [] });
    case 'mcpServer/list': return reply(request.id, { servers: [] });
    case 'session/start': case 'session/new': case 'session/resume': {
      sessionId = params.sessionId ?? randomUUID();
      servers = muse ? Object.entries(params.config?.mcpServers ?? {}).map(([name, value]) => ({ name, ...value }))
        : (params.mcpServers ?? []).map(server => ({ ...server, headers: Object.fromEntries(server.headers.map(item => [item.name, item.value])) }));
      if (provider === 'antigravity' && servers.length) throw new Error('Unverified Antigravity credentials must be gated');
      audit({ event: 'session', sessionId, resumed: Boolean(params.sessionId), servers: servers.map(server => server.name),
        grantInEnvironment: Object.keys(process.env).some(key => key.startsWith('CATS_SESSION_MCP_')) });
      for (const server of servers) {
        await mcp(server, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
        await mcp(server, 'tools/list');
      }
      return reply(request.id, muse ? { session: { sessionId, workspaceRoot: params.workspaceRoots?.[0], activeTurnId: null,
        approvalMode: { mode: 'onRequest' }, permissionState: { profileId: ':ask-me', reviewerAuthority: 'human', reviewerAttached: true,
          axes: { filesystem: 'sandboxed', network: 'off' } } }, pendingRequests: [] }
        : { sessionId, _meta: { currentWorkingDirectory: params.cwd } });
    }
    case 'session/set_model': return reply(request.id, {});
    case 'session/set_config_option': return reply(request.id, { configOptions: [{ id: params.configId, currentValue: params.value }] });
    case 'turn/start': case 'session/prompt': {
      const nativeTurn = `turn-${++turn}`;
      if (muse) reply(request.id, { commandId: params.commandId, disposition: 'started', status: 'accepted', turnId: nativeTurn });
      void runTurn(request, nativeTurn).catch(error => { process.stderr.write(error.message); process.exit(1); });
      return;
    }
    case 'approval/decide':
      reply(request.id, { commandId: params.commandId, status: 'accepted' });
      pending?.(params.choiceId); pending = null; return;
    default: return reply(request.id, {});
  }
}
createInterface({ input: process.stdin }).on('line', line => {
  void handle(JSON.parse(line)).catch(error => { process.stderr.write(error.message); process.exit(1); });
});
