// A scripted stand-in for Claude Code's `claude -p --input-format stream-json
// --output-format stream-json` protocol, registered with the real cats-runtime
// as the `claude` command in integration tests. It answers the runtime's
// `--version` / `--help` probes, stays resident across turns, honours
// `--resume <id>`, and replies deterministically from the message text.
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

function log(entry) {
  if (!logPath) return;
  appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), sessionId, resumed: Boolean(resumed), ...entry })}\n`);
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

let initialized = false;
let turns = 0;
let queue = Promise.resolve();

async function handleTurn(full) {
  const message = userMessageOf(full).trim();
  turns += 1;
  if (!initialized) {
    initialized = true;
    emit({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: [], mcp_servers: [], model, permissionMode: 'default', claude_code_version: '2.1.267' });
  }
  log({ turn: turns, message, args, full });
  let reply;
  if (message.startsWith('slow:')) {
    const ms = Number(message.slice('slow:'.length)) || 1000;
    await sleep(ms);
    reply = `done after ${ms}ms`;
  } else if (message === 'resumed?') {
    reply = `resumed=${resumed ? 'yes' : 'no'}`;
  } else if (message === 'instructions?') {
    reply = `instructions=${full === message ? '' : full.slice(0, full.length - message.length)}`;
  } else if (message.startsWith('tool')) {
    emit({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'file.txt' } }] } });
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'contents of file.txt' }] } });
    reply = 'used a tool';
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
  if (frame && frame.type === 'user') {
    queue = queue.then(() => handleTurn(textOf(frame.message?.content)));
  }
});
rl.on('close', () => {
  queue.then(() => process.exit(0));
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
