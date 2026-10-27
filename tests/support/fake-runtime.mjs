// A stand-in for the cats-runtime bin that speaks the subset of the HTTP
// contract the bot core uses, with behaviour scripted by the message text.
// Started by the real RuntimeSupervisor (same flags, same stdout events), so
// tests of the core exercise the supervisor and client for real while staying
// fast and deterministic. Never used outside tests.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
function flag(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}
const host = flag('--host') ?? '127.0.0.1';
const port = Number(flag('--port') ?? '0');
const apiKey = process.env.CATS_RUNTIME_API_KEY ?? '';
const maxSessions = Number(process.env.FAKE_MAX_SESSIONS ?? '50');
const resumeFails = process.env.FAKE_RESUME_FAILS === '1';
const crashAfterMs = Number(process.env.FAKE_CRASH_AFTER_MS ?? '0');

const sessions = new Map();
const calls = [];
let counter = 0;
let busyOnce = new Set();
let noWorkerOnce = new Set();
let exitOnce = new Set();

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function view(session) {
  return {
    id: session.id,
    status: session.status,
    providerName: session.provider,
    providerSessionId: session.providerSessionId,
    origin: 'runtime',
    model: session.model,
    cwd: session.cwd,
    instructions: session.instructions,
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function handleMessage(req, res, session, body) {
  const message = String(body.message ?? '');
  calls.push({ op: 'message', id: session.id, message });
  if (session.status === 'closed' || session.status === 'closing') {
    return json(res, 400, { error: 'Session is closed. Resume it first.' });
  }
  if (message.startsWith('busy-once') && !busyOnce.has(session.id)) {
    busyOnce.add(session.id);
    return json(res, 409, { error: 'Session is busy processing another message' });
  }
  if (message.startsWith('noworker-once') && !noWorkerOnce.has(session.id)) {
    noWorkerOnce.add(session.id);
    session.status = 'closed';
    return json(res, 404, { error: 'No active worker. Resume the session first.' });
  }
  // Once per runtime process, not per session: the rebuilt session must succeed.
  if (message.startsWith('exit-once') && !exitOnce.has('fired')) {
    exitOnce.add('fired');
    session.status = 'closed';
    return json(res, 410, { error: 'Worker process has exited' });
  }
  if (message.startsWith('guardrail')) {
    return json(res, 429, {
      error: 'Execution cooled down because fake/native hit rate_limited.',
      code: 'guardrail_cooldown',
      guardrail: { outcome: 'cooldown', cooldownUntil: new Date(Date.now() + 60_000).toISOString() },
    });
  }
  if (session.status === 'busy') {
    return json(res, 409, { error: 'Session is busy processing another message' });
  }
  session.status = 'busy';
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Transfer-Encoding': 'chunked' });
  const write = (event) => { res.write(`${JSON.stringify(event)}\n`); };
  const controller = new AbortController();
  session.abort = controller;
  const aborted = () => controller.signal.aborted;
  if (!session.initialized) {
    session.initialized = true;
    write({ type: 'init', sessionId: session.providerSessionId });
  }
  write({ type: 'progress', text: 'thinking', metadata: { kind: 'status' } });
  const finish = (ok) => {
    session.abort = null;
    if (session.status === 'busy') session.status = ok ? 'ready' : 'closed';
    res.end();
  };
  const reply = (text) => {
    session.turns.push({ user: message, assistant: text });
    write({ type: 'text', text });
    write({ type: 'content_block', block: { id: 'b1', index: 0, kind: 'text', status: 'complete', text } });
  };
  if (message.startsWith('slow:')) {
    const ms = Number(message.slice('slow:'.length)) || 1000;
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (aborted()) return finish(false);
      await sleep(25);
    }
    reply(`done after ${ms}ms`);
  } else if (message.startsWith('interrupt')) {
    write({ type: 'text', text: 'partial' });
    return finish(true);
  } else if (message.startsWith('error')) {
    write({ type: 'error', text: 'provider exploded' });
    return finish(true);
  } else if (message.startsWith('tool')) {
    write({ type: 'tool_use', toolName: 'Read', toolId: 't1', text: 'Read file.txt' });
    write({ type: 'tool_result', toolName: 'Read', toolId: 't1', text: 'contents' });
    reply('used a tool');
  } else if (message.startsWith('instructions?')) {
    reply(`instructions=${session.instructions ?? ''}`);
  } else if (message.startsWith('[Cats heartbeat')) {
    reply(session.heartbeatReply ?? '[quiet]');
  } else {
    reply(`echo: ${message}`);
  }
  if (aborted()) return finish(false);
  write({ type: 'result', sessionId: session.providerSessionId, usage: { inputTokens: 1, outputTokens: 1 } });
  finish(true);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${host}`);
  const path = url.pathname;
  if (path === '/__test/state') {
    return json(res, 200, { sessions: [...sessions.values()].map((s) => ({ ...view(s), turns: s.turns })), calls });
  }
  if (apiKey && req.headers.authorization !== `Bearer ${apiKey}`) {
    return json(res, 401, { error: 'unauthorized' });
  }
  if (req.method === 'GET' && path === '/health') {
    return json(res, 200, {
      service: 'cats-runtime', status: 'ok', version: 'fake',
      readiness: { ready: true, phase: 'ready' },
      startup: { mode: 'app-managed', phase: 'ready', ready: true, bootstrapRequired: false, pid: process.pid },
    });
  }
  if (req.method === 'POST' && path === '/sessions') {
    const body = await readBody(req);
    calls.push({ op: 'create', body });
    const live = [...sessions.values()].filter((s) => s.status !== 'closed').length;
    if (live >= maxSessions) {
      return json(res, 500, { error: `Failed to spawn session: Error: Max sessions (${maxSessions}) reached` });
    }
    counter += 1;
    const session = {
      id: `fake-${counter}`, status: 'initializing', provider: body.provider ?? 'claude', model: body.model,
      cwd: body.cwd, instructions: body.instructions, providerSessionId: randomUUID(), turns: [], initialized: false,
      abort: null, mcpServers: body.mcpServers,
    };
    sessions.set(session.id, session);
    return json(res, 200, view(session));
  }
  const match = /^\/sessions\/([^/]+)(?:\/(messages|resume|close|cancel|history|observe))?$/u.exec(path);
  if (!match) return json(res, 404, { error: 'not found' });
  const session = sessions.get(decodeURIComponent(match[1]));
  if (!session) return json(res, 404, { error: 'Session not found' });
  const action = match[2];
  if (req.method === 'GET' && !action) return json(res, 200, view(session));
  if (req.method === 'DELETE' && !action) {
    calls.push({ op: 'delete', id: session.id });
    sessions.delete(session.id);
    return json(res, 200, { deleted: true });
  }
  if (req.method === 'POST' && action === 'messages') {
    return handleMessage(req, res, session, await readBody(req));
  }
  if (req.method === 'POST' && action === 'resume') {
    const body = await readBody(req);
    calls.push({ op: 'resume', id: session.id, body });
    if (resumeFails) return json(res, 500, { error: 'Failed to resume: boom' });
    session.status = 'ready';
    return json(res, 200, { ...view(session), action: 'resume' });
  }
  if (req.method === 'POST' && action === 'close') {
    calls.push({ op: 'close', id: session.id });
    session.abort?.abort();
    session.status = 'closed';
    return json(res, 200, { ...view(session), action: 'close' });
  }
  if (req.method === 'POST' && action === 'cancel') {
    calls.push({ op: 'cancel', id: session.id });
    if (session.abort) {
      session.abort.abort();
      session.status = 'closed';
    }
    return json(res, 200, { ...view(session), action: 'cancel' });
  }
  if (req.method === 'GET' && action === 'history') {
    const messages = session.turns.flatMap((turn) => [
      { role: 'user', text: turn.user }, { role: 'assistant', text: turn.assistant },
    ]);
    return json(res, 200, { messages });
  }
  if (req.method === 'GET' && action === 'observe') {
    return json(res, 200, { session: view(session) });
  }
  return json(res, 404, { error: 'not found' });
});

function lifecycle(event, extra = {}) {
  process.stdout.write(`${JSON.stringify({ event, service: 'cats-runtime', pid: process.pid, mode: 'app-managed', ...extra })}\n`);
}

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  lifecycle('runtime.ready', { host, port: actualPort, healthUrl: `http://${host}:${actualPort}/health`, ready: true });
  if (crashAfterMs > 0) {
    setTimeout(() => process.exit(3), crashAfterMs);
  }
});

function shutdown(reason) {
  lifecycle('runtime.stopping', { reason });
  server.close(() => {
    lifecycle('runtime.stopped', { reason });
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 500).unref();
}
process.stdin.on('end', () => shutdown('stdin_closed'));
process.stdin.on('close', () => shutdown('stdin_closed'));
process.stdin.resume();
process.on('SIGTERM', () => shutdown('sigterm'));
process.on('SIGINT', () => shutdown('sigint'));
