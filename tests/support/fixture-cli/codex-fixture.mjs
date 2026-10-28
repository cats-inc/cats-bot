import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

if (process.argv.includes('--version')) { console.log('codex-cli 0.164.0'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('codex app-server --listen stdio://'); process.exit(0); }
const threadId = randomUUID();
let turnId = '';
let cwd = process.cwd();
let sandbox = 'workspace-write';
let approval = 'on-request';
let requestId = 0;
const mcp = new Map();
for (const arg of process.argv) {
  const match = /^mcp_servers\.([^.]+)\.(url|bearer_token_env_var|default_tools_approval_mode)=(.+)$/.exec(arg);
  if (match) mcp.set(match[1], { ...mcp.get(match[1]), [match[2]]: JSON.parse(match[3]) });
}
let desktopStep = 0;
let pendingDesktop = null;
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (id, result) => send({ id, result });
const event = (method, params) => send({ method, params });
const complete = text => {
  event('item/agentMessage/delta', { threadId, turnId, itemId: 'answer', delta: text });
  event('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
};
const requestDesktop = (name, args) => {
  if (mcp.get('cats-desktop')?.default_tools_approval_mode !== 'prompt') {
    complete('desktop tool is missing an explicit prompt policy'); return;
  }
  requestId++;
  pendingDesktop = { name, args, id: `desktop-${requestId}` };
  event('item/started', { threadId, turnId, item: { type: 'mcpToolCall', id: pendingDesktop.id,
    server: 'cats-desktop', tool: name, arguments: args, status: 'inProgress' } });
  send({ id: requestId, method: 'mcpServer/elicitation/request', params: { threadId, turnId,
    serverName: 'cats-desktop', mode: 'form',
    _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: args },
    message: `Allow the cats-desktop MCP server to run tool "${name}"?`,
    requestedSchema: { type: 'object', properties: {} } } });
};
createInterface({ input: process.stdin }).on('line', async line => {
  const frame = JSON.parse(line);
  switch (frame.method) {
    case 'initialize': reply(frame.id, { userAgent: 'fixture' }); break;
    case 'config/read': reply(frame.id, { config: {}, layers: [] }); break;
    case 'thread/start': case 'thread/resume':
      cwd = frame.params.cwd ?? cwd;
      sandbox = frame.params.sandbox ?? sandbox;
      approval = frame.params.approvalPolicy ?? approval;
      reply(frame.id, { thread: { id: threadId }, cwd, approvalPolicy: approval, approvalsReviewer: 'user',
        sandbox: sandbox === 'workspace-write' ? { type: 'workspaceWrite', writableRoots: [], networkAccess: false }
          : sandbox === 'read-only' ? { type: 'readOnly', access: { type: 'fullAccess' } } : { type: 'dangerFullAccess' } });
      break;
    case 'turn/start': {
      turnId = randomUUID(); reply(frame.id, { turn: { id: turnId } });
      const text = frame.params.input?.map(i => i.text ?? '').join('') ?? '';
      if (text.includes('provider-desktop')) {
        desktopStep = 0;
        requestDesktop('request_app_access', { apps: ['記事本'], reason: 'Read the fixture window' }); break;
      }
      if (!text.includes('provider-question') && !text.includes('provider-form')) { complete('fixture completed'); break; }
      requestId += 1;
      if (text.includes('provider-form')) {
        send({ id: requestId, method: 'mcpServer/elicitation/request', params: {
          threadId, turnId, serverName: 'fixture_tools', mode: 'form', message: 'Required keys may contain empty values',
          requestedSchema: { type: 'object', required: ['text', 'tags'], properties: {
            text: { type: 'string', title: 'Text' },
            tags: { type: 'array', title: 'Tags', items: { type: 'string', enum: ['a', 'b'] } },
            empty: { type: 'string', title: 'Explicit empty', enum: ['', 'other'] },
          } },
        } });
        break;
      }
      send({ id: requestId, method: 'item/tool/requestUserInput', params: { threadId, turnId,
        questions: [{ id: 'answer', header: 'Fixture', question: 'Choose the fixture response', options: [{ label: 'Continue', description: 'Continue this same turn' }] }] } });
      break;
    }
    case 'mcpServerStatus/list':
      reply(frame.id, { data: [{ name: 'fixture_tools', runtimeStatus: 'connected', authStatus: 'unsupported',
        tools: { inspect: { name: 'inspect' } } }], nextCursor: null }); break;
    case 'turn/interrupt': complete('interrupted'); reply(frame.id, {}); break;
    default:
      if (frame.id === requestId && (frame.result || frame.error)) {
        event('serverRequest/resolved', { threadId, requestId });
        if (pendingDesktop) {
          const call = pendingDesktop; pendingDesktop = null;
          if (frame.result?.action !== 'accept') { complete('desktop tool declined'); break; }
          const server = mcp.get('cats-desktop');
          const response = await fetch(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env[server.bearer_token_env_var]}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: call.id, method: 'tools/call', params: { name: call.name, arguments: call.args } }) });
          const result = (await response.json()).result;
          event('item/completed', { threadId, turnId, item: { type: 'mcpToolCall', id: call.id,
            server: 'cats-desktop', tool: call.name, arguments: call.args, status: result?.isError ? 'failed' : 'completed', result } });
          if (result?.isError) { complete('desktop request stopped'); break; }
          if (desktopStep++ === 0) requestDesktop('list_windows', {});
          else if (desktopStep === 2) {
            const data = result.structuredContent;
            requestDesktop('read_ui', { windowId: data.windows[0].windowId });
          } else complete('desktop fixture read completed');
          break;
        }
        complete(frame.result?.content?.text === '' && frame.result.content.empty === '' && Array.isArray(frame.result.content.tags) && frame.result.content.tags.length === 0
          ? 'empty form accepted' : frame.result?.answers?.answer?.answers?.[0] === 'Continue' ? 'native response received' : 'request cancelled');
      }
  }
});
