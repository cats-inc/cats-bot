import assert from 'node:assert/strict';
import { test } from 'node:test';

import { entrySpeaker, headerCat, reachesTelegram, selfSpeaker, type NoteCast } from '../../src/renderer/note/speakers.ts';

/** SPEC-003 FR-15, FR-16, SPEC-009 FR-10, SPEC-012 FR-5: who speaks in a note, where, and by which face. */

const qq = { name: 'QQ', avatar: 'qq.svg', bossCat: false };
const boss = { id: 'boss', name: 'Boss', avatar: 'boss.svg', bossCat: true };
const mochi = { id: 'mochi', name: 'Mochi', avatar: 'mochi.svg', bossCat: false };
const owner = { kind: 'owner', origin: 'owner' } as const;
const heartbeat = { kind: 'bot', origin: 'heartbeat' } as const;

test('a talk between the owner and one cat carries no faces in its bubbles; the header has the cat', () => {
  const cast: NoteCast = { self: qq, peers: [boss], contact: null };
  assert.deepEqual(entrySpeaker(owner, cast), { side: 'right', cat: null });
  assert.deepEqual(selfSpeaker(cast), { side: 'left', cat: null });
  assert.deepEqual(entrySpeaker(heartbeat, cast), { side: 'left', cat: null });
  assert.deepEqual(headerCat(cast), qq);
  // The Boss Cat's own talk with the owner: still no faces, the header's face is ringed (bossCat).
  const bossCast: NoteCast = { self: { ...boss }, peers: [mochi], contact: null };
  assert.equal(headerCat(bossCast).bossCat, true);
  assert.deepEqual(selfSpeaker(bossCast), { side: 'left', cat: null });
});

test('another cat\'s reply in the Boss Cat\'s talk sits with the cats, by its face and name', () => {
  const cast: NoteCast = { self: { name: 'Boss', avatar: 'boss.svg', bossCat: true }, peers: [mochi], contact: null };
  assert.deepEqual(entrySpeaker({ kind: 'owner', origin: 'bot', from: 'Mochi' }, cast),
    { side: 'left', cat: { name: 'Mochi', avatar: 'mochi.svg', bossCat: false } });
  // A cat the note does not know by look still has its name; its face is drawn from the initial.
  assert.deepEqual(entrySpeaker({ kind: 'owner', origin: 'bot', from: 'Tama' }, cast),
    { side: 'left', cat: { name: 'Tama', avatar: undefined, bossCat: false } });
});

test('a contact note puts the Boss Cat on the right and the cat it looks after on the left, both by face', () => {
  // The looked-after cat's own contact note: the Boss Cat's messages come in on the right.
  const kept: NoteCast = { self: qq, peers: [boss], contact: { id: 'boss', name: 'Boss' } };
  assert.deepEqual(entrySpeaker({ kind: 'owner', origin: 'bot', from: 'Boss' }, kept),
    { side: 'right', cat: { name: 'Boss', avatar: 'boss.svg', bossCat: true } });
  assert.deepEqual(selfSpeaker(kept), { side: 'left', cat: qq });
  assert.deepEqual(headerCat(kept), qq);
  // The Boss Cat's contact note for a cat: it writes on the right, and the header shows the cat it looks after.
  const bossSelf = { name: 'Boss', avatar: 'boss.svg', bossCat: true };
  const keeping: NoteCast = { self: bossSelf, peers: [mochi], contact: { id: 'mochi', name: 'Mochi' } };
  assert.deepEqual(selfSpeaker(keeping), { side: 'right', cat: bossSelf });
  assert.deepEqual(entrySpeaker({ kind: 'owner', origin: 'bot', from: 'Mochi' }, keeping),
    { side: 'left', cat: { name: 'Mochi', avatar: 'mochi.svg', bossCat: false } });
  assert.deepEqual(headerCat(keeping), { name: 'Mochi', avatar: 'mochi.svg', bossCat: false });
  // The role moved on: neither cat holds it, and the note keeps the side the messages came in on.
  const former: NoteCast = { self: qq, peers: [], contact: { id: 'old-boss', name: 'Old boss' } };
  assert.deepEqual(entrySpeaker({ kind: 'owner', origin: 'bot', from: 'Old boss' }, former),
    { side: 'right', cat: { name: 'Old boss', avatar: undefined, bossCat: false } });
  assert.deepEqual(selfSpeaker(former), { side: 'left', cat: qq });
});

test('the direct message is Telegram\'s once Telegram is on, its token stored and the owner\'s chat bound', () => {
  assert.equal(reachesTelegram({ enabled: true, ownerChatId: 42 }, true), true);
  assert.equal(reachesTelegram({ enabled: false, ownerChatId: 42 }, true), false);
  assert.equal(reachesTelegram({ enabled: true, ownerChatId: 42 }, false), false);
  // Not bound yet: nothing reaches Telegram until the owner writes to the bot there.
  assert.equal(reachesTelegram({ enabled: true, ownerChatId: null }, true), false);
});
