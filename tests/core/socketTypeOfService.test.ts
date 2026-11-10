import assert from 'node:assert/strict';
import { Socket } from 'node:net';
import { test } from 'node:test';

import { ignoreTypeOfServiceErrors } from '../../src/core/runtime/socketTypeOfService.ts';
import '../../src/core/runtime/client.ts';

test('a failing setTypeOfService is ignored, as Node 26\'s undici does, and wrapped only once', () => {
  let calls = 0;
  const target = {
    setTypeOfService(this: unknown, value: number) {
      calls += 1;
      if (value === 0) throw Object.assign(new Error('setTypeOfService EINVAL'), { code: 'EINVAL', syscall: 'setTypeOfService' });
      return this;
    },
  };
  ignoreTypeOfServiceErrors(target);
  const wrapped = target.setTypeOfService;
  assert.equal(target.setTypeOfService(0), target, 'the error is swallowed and the socket returned');
  assert.equal(target.setTypeOfService(16), target);
  assert.equal(calls, 2);
  ignoreTypeOfServiceErrors(target);
  assert.equal(target.setTypeOfService, wrapped, 'a second call does not wrap again');
});

test('a Node without setTypeOfService is left alone, and the runtime client guards real sockets where it exists', () => {
  const target: { setTypeOfService?: () => unknown } = {};
  ignoreTypeOfServiceErrors(target);
  assert.equal(target.setTypeOfService, undefined);
  const method = (Socket.prototype as unknown as { setTypeOfService?: unknown }).setTypeOfService;
  if (typeof method === 'function') {
    assert.equal((Socket.prototype as unknown as Record<symbol, unknown>)[Symbol.for('cats-bot.setTypeOfService.guarded')], true);
  }
});
