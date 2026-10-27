import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';

import { FileSecretStore, SECRET_TELEGRAM_TOKEN, secretsPath, type SecretCipher } from '../../src/core/secrets.ts';
import { makeTempHome, type TempHome } from '../support/harness.ts';

let home: TempHome;
before(() => {
  home = makeTempHome('cats-bots-secrets-');
});
after(() => home.cleanup());

const flipCipher: SecretCipher = {
  label: 'test-flip',
  encrypt: (plain) => Buffer.from(Buffer.from(plain, 'utf8').map((byte) => byte ^ 0x5a)),
  decrypt: (cipher) => Buffer.from(cipher.map((byte) => byte ^ 0x5a)).toString('utf8'),
};

test('a plain file store round-trips a secret without writing it in clear text as a plain key', () => {
  const store = new FileSecretStore(home.botsHome);
  assert.equal(store.protection(), 'file');
  assert.equal(store.has(SECRET_TELEGRAM_TOKEN), false);
  store.set(SECRET_TELEGRAM_TOKEN, '123456:ABC-DEF');
  assert.equal(store.get(SECRET_TELEGRAM_TOKEN), '123456:ABC-DEF');
  const raw = readFileSync(secretsPath(home.botsHome), 'utf8');
  assert.doesNotMatch(raw, /123456:ABC-DEF/u, 'the file holds the base64 form, not the raw token');
  store.delete(SECRET_TELEGRAM_TOKEN);
  assert.equal(store.get(SECRET_TELEGRAM_TOKEN), null);
});

test('a cipher-backed store encrypts, and a host without that cipher cannot read the value', () => {
  const warnings: string[] = [];
  const protectedStore = new FileSecretStore(home.botsHome, { cipher: flipCipher });
  assert.equal(protectedStore.protection(), 'os');
  protectedStore.set('apiKey', 'secret-value');
  assert.equal(protectedStore.get('apiKey'), 'secret-value');
  const raw = readFileSync(secretsPath(home.botsHome), 'utf8');
  assert.match(raw, /"cipher": "test-flip"/u);
  assert.doesNotMatch(raw, /secret-value/u);
  const plain = new FileSecretStore(home.botsHome, { warn: (line) => warnings.push(line) });
  assert.equal(plain.get('apiKey'), null);
  assert.equal(plain.has('apiKey'), true);
  assert.match(warnings[0] ?? '', /protected with test-flip/u);
});
