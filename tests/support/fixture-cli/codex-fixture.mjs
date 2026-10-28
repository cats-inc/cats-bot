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
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (id, result) => send({ id, result });
const event = (method, params) => send({ method, params });
const complete = text => {
  event('item/agentMessage/delta', { threadId, turnId, itemId: 'answer', delta: text });
  event('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
};
createInterface({ input: process.stdin }).on('line', line => {
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
      if (!text.includes('provider-question')) { complete('fixture completed'); break; }
      requestId += 1;
      send({ id: requestId, method: 'item/tool/requestUserInput', params: { threadId, turnId,
        questions: [{ id: 'answer', header: 'Fixture', question: 'Choose the fixture response', options: [{ label: 'Continue', description: 'Continue this same turn' }] }] } });
      break;
    }
    case 'mcpServerStatus/list':
      reply(frame.id, { data: [{ name: 'fixture_tools', status: 'connected', authStatus: 'unsupported',
        tools: { inspect: { name: 'inspect' } } }], nextCursor: null }); break;
    case 'turn/interrupt': complete('interrupted'); reply(frame.id, {}); break;
    default:
      if (frame.id === requestId && (frame.result || frame.error)) {
        event('serverRequest/resolved', { threadId, requestId });
        complete(frame.result?.answers?.answer?.answers?.[0] === 'Continue' ? 'native response received' : 'request cancelled');
      }
  }
});
