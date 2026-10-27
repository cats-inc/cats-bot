import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createBotToolHandlers } from '../../src/core/tools/botTools.ts';
import { BotToolServer } from '../../src/core/tools/server.ts';
import type { ScheduleRecord, WorkItem } from '../../src/core/types.ts';

/** The MCP Streamable HTTP endpoint the provider CLI talks to (FR-24). */

const now = new Date('2026-10-27T10:00:00.000Z');
const created: ScheduleRecord[] = [];
const asked: Array<{ conversationId: string; question: string }> = [];
let server: BotToolServer;

before(async () => {
  server = new BotToolServer({
    serverVersion: 'test',
    handlers: createBotToolHandlers({
      createSchedule: (input) => {
        const record: ScheduleRecord = {
          id: `sch-${created.length + 1}`,
          conversationId: input.conversationId,
          kind: input.kind,
          ...(input.at ? { at: input.at.toISOString() } : {}),
          ...(input.cron ? { cron: input.cron } : {}),
          timezone: input.timezone ?? 'UTC',
          prompt: input.prompt,
          missedPolicy: input.missedPolicy ?? 'run_once',
          graceMinutes: 1_440,
          createdBy: input.createdBy,
          receipt: `sch-${created.length + 1}@now`,
          state: 'active',
          createdAt: now.toISOString(),
          lastFiredAt: null,
          nextAt: input.at ? input.at.toISOString() : '2026-10-28T01:00:00.000Z',
        };
        created.push(record);
        return record;
      },
      listSchedules: () => created,
      cancelSchedule: (id) => {
        const record = created.find((schedule) => schedule.id === id);
        if (!record) throw new Error(`Unknown schedule ${id}`);
        record.state = 'cancelled';
        return record;
      },
      askOwner: (conversationId, question) => {
        asked.push({ conversationId, question });
        return { id: 'wi-ask', prompt: question } as WorkItem;
      },
      now: () => now,
    }),
  });
  await server.start();
});
after(async () => {
  await server.stop();
});

async function rpc(path: string, body: unknown, token = server.token): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${server.url!.replace(/\/mcp$/u, '')}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

test('the descriptor names the conversation in the URL and carries the bearer token', () => {
  const [descriptor] = server.descriptorFor('conv-1');
  assert.equal(descriptor?.name, 'cats-bot');
  assert.equal(descriptor?.transport, 'http');
  assert.match(descriptor?.url ?? '', /^http:\/\/127\.0\.0\.1:\d+\/mcp\/conv-1$/u);
  assert.deepEqual(descriptor?.auth, { kind: 'bearer_env', token: server.token });
});

test('initialize, tools/list and tools/call speak JSON-RPC over HTTP', async () => {
  const init = await rpc('/mcp/conv-1', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
  assert.equal(init.status, 200);
  assert.equal((init.json as { result: { protocolVersion: string } }).result.protocolVersion, '2025-06-18');
  const notified = await rpc('/mcp/conv-1', { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notified.status, 202);
  const list = await rpc('/mcp/conv-1', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = (list.json as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ['schedule_create', 'schedule_list', 'schedule_cancel', 'ask_owner']);

  const call = await rpc('/mcp/conv-1', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'schedule_create', arguments: { prompt: 'water the plants', delayMinutes: 30 } } });
  const text = (call.json as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
  assert.match(text, /Scheduled sch-1 once at 2026-10-27T10:30:00\.000Z: water the plants/u);
  assert.match(text, /Receipt: sch-1@now/u);
  assert.equal(created[0]?.conversationId, 'conv-1', 'the conversation came from the URL');
  assert.equal(created[0]?.createdBy, 'agent');

  const listed = await rpc('/mcp/conv-1', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'schedule_list', arguments: {} } });
  assert.match((listed.json as { result: { content: Array<{ text: string }> } }).result.content[0]!.text, /sch-1/u);
  const cancelled = await rpc('/mcp/conv-1', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'schedule_cancel', arguments: { id: 'sch-1' } } });
  assert.match((cancelled.json as { result: { content: Array<{ text: string }> } }).result.content[0]!.text, /Cancelled sch-1/u);
  const ask = await rpc('/mcp/conv-2', { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'ask_owner', arguments: { question: 'May I delete the cache?' } } });
  assert.match((ask.json as { result: { content: Array<{ text: string }> } }).result.content[0]!.text, /approval wi-ask/u);
  assert.deepEqual(asked, [{ conversationId: 'conv-2', question: 'May I delete the cache?' }]);

  const bad = await rpc('/mcp/conv-1', { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'schedule_create', arguments: { prompt: 'x' } } });
  const badResult = (bad.json as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
  assert.equal(badResult.isError, true);
  const unknown = await rpc('/mcp/conv-1', { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  assert.equal((unknown.json as { error: { code: number } }).error.code, -32602);
  const missing = await rpc('/mcp/conv-1', { jsonrpc: '2.0', id: 9, method: 'resources/list' });
  assert.equal((missing.json as { error: { code: number } }).error.code, -32601);
});

test('a wrong or missing token is refused', async () => {
  const refused = await rpc('/mcp/conv-1', { jsonrpc: '2.0', id: 1, method: 'ping' }, 'nope');
  assert.equal(refused.status, 401);
  const get = await fetch(`${server.url}/conv-1`, { headers: { Authorization: `Bearer ${server.token}` } });
  assert.equal(get.status, 405);
});

test('schedule_list and schedule_cancel only see schedules of the calling conversation (FR-24)', async () => {
  const call = async (conversationId: string, name: string, args: Record<string, unknown>) => {
    const reply = await rpc(`/mcp/${conversationId}`, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    return (reply.json as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
  };
  const made = await call('note-a', 'schedule_create', { prompt: 'the vault code is 0451', delayMinutes: 60 });
  const id = /Scheduled (sch-\d+)/u.exec(made.content[0]!.text)?.[1];
  assert.ok(id, 'note A got a receipt');

  const listedByB = await call('note-b', 'schedule_list', {});
  assert.doesNotMatch(listedByB.content[0]!.text, /0451|sch-/u, 'note B does not see note A\'s schedule');
  const cancelledByB = await call('note-b', 'schedule_cancel', { id });
  const unknownToB = await call('note-b', 'schedule_cancel', { id: 'sch-999' });
  assert.equal(cancelledByB.isError, true);
  assert.equal(cancelledByB.content[0]!.text.replace(id!, 'ID'), unknownToB.content[0]!.text.replace('sch-999', 'ID'), 'a foreign schedule reads like an unknown one');
  assert.equal(created.find((schedule) => schedule.id === id)?.state, 'active', 'note B could not cancel it');

  const listedByA = await call('note-a', 'schedule_list', {});
  assert.match(listedByA.content[0]!.text, /0451/u);
  const cancelledByA = await call('note-a', 'schedule_cancel', { id });
  assert.notEqual(cancelledByA.isError, true);
  assert.equal(created.find((schedule) => schedule.id === id)?.state, 'cancelled');
});
