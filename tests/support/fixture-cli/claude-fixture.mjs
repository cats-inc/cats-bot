// A scripted stand-in for Claude Code's `claude -p --input-format stream-json
// --output-format stream-json` protocol, registered with the real cats-runtime
// as the `claude` command in integration tests. It answers the runtime's
// `--version` / `--help` probes, stays resident across turns, honours
// `--resume <id>`, replies deterministically from the message text, and can
// call the bot's own MCP tool server the way the real CLI would (through the
// `--mcp-config` the runtime passes, with the bearer token from the
// environment variable the runtime sets).
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write('2.1.267 (Claude Code)\n');
  process.exit(0);
}
if (args.includes('--help')) {
  process.stdout.write([
    'Usage: claude [options] [command] [prompt]',
    '  -p, --print',
    '  --input-format <format>   stream-json',
    '  --output-format <format>  stream-json',
    '  --include-partial-messages',
    '  --verbose',
    '  --resume <id>',
    '  --model <model>',
    '  --mcp-config <json>',
    '  --permission-mode <mode>',
    '  --permission-prompt-tool <tool>',
    '  --chrome',
    '',
  ].join('\n'));
  process.exit(0);
}

const resumeIndex = args.indexOf('--resume');
const resumed = resumeIndex !== -1 ? args[resumeIndex + 1] : null;
const sessionId = resumed ?? randomUUID();
const modelIndex = args.indexOf('--model');
const model = modelIndex !== -1 ? args[modelIndex + 1] : 'claude-fixture';
const logPath = process.env.CATS_BOTS_FIXTURE_LOG;
const modeIndex = args.indexOf('--permission-mode');
const launchedMode = modeIndex !== -1 ? args[modeIndex + 1] : null;
// What `initialize` reports: `manual` reports `default`; no flag stands for the user's own mode.
const permissionMode = args.includes('--dangerously-skip-permissions') ? 'bypassPermissions'
  : launchedMode === 'manual' ? 'default' : launchedMode ?? 'auto';
const hostPrompts = args[args.indexOf('--permission-prompt-tool') + 1] === 'stdio';
const chrome = args.includes('--chrome');

const mcpIndex = args.indexOf('--mcp-config');
let mcpServers = {};
if (mcpIndex !== -1) {
  try {
    mcpServers = JSON.parse(args[mcpIndex + 1] ?? '{}').mcpServers ?? {};
  } catch {
    mcpServers = {};
  }
}

function expandEnv(value) {
  return String(value).replace(/\$\{([A-Z0-9_]+)\}/gu, (_, name) => process.env[name] ?? '');
}

async function callTool(name, toolArgs) {
  const server = mcpServers['cats-bot'];
  if (!server) return 'no cats-bot MCP server configured';
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  for (const [key, value] of Object.entries(server.headers ?? {})) headers[key] = expandEnv(value);
  const rpc = async (method, params, id) => {
    const response = await fetch(server.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    if (response.status === 202) return null;
    return response.json();
  };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-fixture', version: '0' } }, 1);
  await rpc('notifications/initialized', {});
  const result = await rpc('tools/call', { name, arguments: toolArgs }, 2);
  if (result?.error) return `tool error: ${result.error.message}`;
  return (result?.result?.content ?? []).map((block) => block.text ?? '').join('');
}

function log(entry) {
  if (!logPath) return;
  appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), sessionId, resumed: Boolean(resumed), mcp: Object.keys(mcpServers), ...entry })}\n`);
}

function emit(frame) {
  process.stdout.write(`${JSON.stringify({ ...frame, session_id: sessionId })}\n`);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === 'string' ? block : block && block.type === 'text' ? block.text ?? '' : ''))
      .join('');
  }
  return '';
}

/** The runtime may prefix the user message with an instructions layer. */
function userMessageOf(full) {
  const marker = '\nUser message:\n';
  const index = full.lastIndexOf(marker);
  return index === -1 ? full : full.slice(index + marker.length);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Host answers to this CLI's own control requests, by request_id. */
const answers = new Map();
let controlId = 0;
function askHost(request) {
  const requestId = `fixture-${++controlId}`;
  process.stdout.write(`${JSON.stringify({ type: 'control_request', request_id: requestId, request })}\n`);
  return new Promise((resolve) => answers.set(requestId, resolve));
}
function answerHost(requestId, response) {
  process.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })}\n`);
}
function serverStatus() {
  return [
    ...Object.keys(mcpServers).map((name) => ({ name, status: 'connected', scope: 'dynamic', tools: [{ name: 'ask_owner' }] })),
    ...(chrome ? [{ name: 'claude-in-chrome', status: 'connected', scope: 'dynamic', tools: [{ name: 'navigate' }] }] : []),
  ];
}

let initialized = false;
let turns = 0;
let queue = Promise.resolve();
/** Per-process memory: what one session remembers, another cannot recall (SPEC-001 A4). */
let remembered = null;

async function handleTurn(full) {
  const message = userMessageOf(full).trim();
  turns += 1;
  if (!initialized) {
    initialized = true;
    emit({
      type: 'system', subtype: 'init', cwd: process.cwd(), tools: ['Read', 'Bash', ...(hostPrompts ? ['AskUserQuestion'] : [])],
      model, permissionMode, claude_code_version: '2.1.267',
      mcp_servers: Object.keys(mcpServers).map((name) => ({ name, status: 'connected' })),
    });
  }
  log({ turn: turns, message, args, full });
  let reply;
  if (message.startsWith('slow:')) {
    const ms = Number(message.slice('slow:'.length)) || 1000;
    await sleep(ms);
    reply = `done after ${ms}ms`;
  } else if (message === 'resumed?') {
    reply = `resumed=${resumed ? 'yes' : 'no'}`;
  } else if (message.startsWith('remember:')) {
    remembered = message.slice('remember:'.length).trim();
    reply = `remembered ${remembered}`;
  } else if (message === 'recall?') {
    reply = `recall=${remembered ?? 'nothing'}`;
  } else if (message === 'model?') {
    reply = `model=${model}`;
  } else if (message === 'instructions?') {
    reply = `instructions=${full === message ? '' : full.slice(0, full.length - message.length)}`;
  } else if (message.startsWith('tool')) {
    emit({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'file.txt' } }] } });
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'contents of file.txt' }] } });
    reply = 'used a tool';
  } else if (message.startsWith('schedule:')) {
    const [, minutes, ...prompt] = message.split(':');
    const text = await callTool('schedule_create', { prompt: prompt.join(':'), delayMinutes: Number(minutes) });
    reply = `scheduled -> ${text}`;
  } else if (message.startsWith('cron:')) {
    const [, expression, ...prompt] = message.split('|');
    const text = await callTool('schedule_create', { prompt: prompt.join('|'), cron: expression });
    reply = `scheduled -> ${text}`;
  } else if (message.startsWith('ask:')) {
    const text = await callTool('ask_owner', { question: message.slice('ask:'.length) });
    reply = `asked -> ${text}`;
  } else if (message === 'schedules?') {
    reply = await callTool('schedule_list', {});
  } else if (message === 'native-question') {
    const question = 'Which fixture color?';
    const answer = hostPrompts ? await askHost({ subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion',
      requires_user_interaction: true, tool_use_id: 'toolu_q', input: { questions: [{ question, header: 'Color', multiSelect: false,
        options: [{ label: 'Red' }, { label: 'Blue' }] }] } }) : { behavior: 'deny' };
    reply = answer.behavior === 'allow' ? `answered ${answer.updatedInput?.answers?.[question]}` : 'question denied';
  } else if (message === 'native-chrome') {
    const answer = !chrome ? null : await askHost({ subtype: 'can_use_tool', tool_name: 'mcp__claude-in-chrome__navigate',
      display_name: 'Navigate', mcp_server: { name: 'claude-in-chrome', source: 'dynamic' }, tool_use_id: 'toolu_c',
      input: { url: 'https://example.com' } });
    reply = !answer ? 'no chrome' : answer.behavior === 'allow' ? 'navigate allowed' : 'navigate denied';
  } else if (message === 'native-form') {
    const answer = await askHost({ subtype: 'elicitation', mcp_server_name: 'fixture_tools', message: 'Pick one', mode: 'form',
      requested_schema: { type: 'object', properties: { choice: { type: 'string', enum: ['a', 'b'] } }, required: ['choice'] } });
    reply = `form ${answer.action} ${answer.content?.choice ?? ''}`.trim();
  } else if (message.startsWith('[Cats heartbeat')) {
    reply = process.env.CATS_BOTS_FIXTURE_HEARTBEAT_REPLY || '[quiet]';
  } else {
    reply = `echo: ${message}`;
  }
  emit({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text: reply }] } });
  emit({
    type: 'result', subtype: 'success', is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1,
    result: reply, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let frame;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (frame && frame.type === 'control_response') {
    const resolve = answers.get(frame.response?.request_id);
    answers.delete(frame.response?.request_id);
    resolve?.(frame.response?.response ?? {});
    return;
  }
  if (frame && frame.type === 'control_request') {
    const subtype = frame.request?.subtype;
    if (subtype === 'initialize') answerHost(frame.request_id, { current_permission_mode: permissionMode, commands: [] });
    else if (subtype === 'mcp_status') answerHost(frame.request_id, { mcpServers: serverStatus() });
    else process.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: 'unsupported' } })}\n`);
    return;
  }
  if (frame && frame.type === 'user') {
    queue = queue.then(() => handleTurn(textOf(frame.message?.content)));
  }
});
rl.on('close', () => {
  queue.then(() => process.exit(0));
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
