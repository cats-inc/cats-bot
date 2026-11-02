import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { avatarSvg, avatarUrl } from '../../src/renderer/avatarArt.ts';
import { BOT_AVATARS, BOT_AVATAR_LABELS, DEFAULT_BOT_AVATAR, nextBotAvatar, resolveBotAvatar } from '../../src/shared/avatars.ts';
import { translate, zhTW } from '../../src/shared/language.ts';

// SPEC-008 FR-29.

test('there are ten looks, the default first, each named in both languages', () => {
  assert.equal(BOT_AVATARS.length, 10);
  assert.equal(new Set(BOT_AVATARS).size, 10);
  for (const required of ['tabby', 'white-tabby'] as const) assert.ok(BOT_AVATARS.includes(required), required);
  assert.equal(BOT_AVATARS[0], DEFAULT_BOT_AVATAR);
  for (const avatar of BOT_AVATARS) {
    assert.ok(BOT_AVATAR_LABELS[avatar]);
    assert.ok(zhTW[BOT_AVATAR_LABELS[avatar]], avatar);
    assert.notEqual(translate('zh-TW', BOT_AVATAR_LABELS[avatar]), BOT_AVATAR_LABELS[avatar]);
  }
});

test('a new bot takes the first look nobody uses, then the least used', () => {
  assert.equal(nextBotAvatar([]), 'ginger');
  assert.equal(nextBotAvatar(['ginger']), 'tuxedo');
  assert.equal(nextBotAvatar(['ginger', 'ginger', 'ginger']), 'tuxedo', 'three upgraded bots with the default Cat');
  assert.equal(nextBotAvatar(['tuxedo', 'ginger']), 'siamese');
  assert.equal(nextBotAvatar(['ginger', 'siamese']), 'tuxedo', 'a gap is filled first');
  assert.equal(nextBotAvatar(['ginger', 'tuxedo', 'siamese', 'calico']), 'fold');
  assert.equal(nextBotAvatar(['ginger', 'tuxedo', 'siamese', 'calico', 'fold']), 'tabby', 'a full hub of the first five');
  assert.equal(nextBotAvatar([...BOT_AVATARS, 'ginger']), 'tuxedo', 'all used: the least used');
});

test('a look on an archived bot is passed over while another is free, and is used before sharing one', () => {
  assert.equal(nextBotAvatar(['ginger'], ['tuxedo']), 'siamese');
  assert.equal(nextBotAvatar(BOT_AVATARS.filter((avatar) => avatar !== 'tuxedo'), ['tuxedo']), 'tuxedo');
  assert.equal(nextBotAvatar([...BOT_AVATARS], ['ginger']), 'tuxedo');
});

test('what is not a look reads as the default Cat', () => {
  for (const avatar of BOT_AVATARS) assert.equal(resolveBotAvatar(avatar), avatar);
  for (const unknown of [undefined, null, 'dragon', 3, {}]) {
    assert.equal(resolveBotAvatar(unknown), DEFAULT_BOT_AVATAR);
    assert.equal(avatarSvg(unknown), avatarSvg(DEFAULT_BOT_AVATAR));
  }
});

test('every drawing is different and has what the floating Cat animates', () => {
  assert.equal(new Set(BOT_AVATARS.map((avatar) => avatarSvg(avatar))).size, BOT_AVATARS.length);
  for (const avatar of BOT_AVATARS) {
    const svg = avatarSvg(avatar);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 128 128">/u, avatar);
    for (const hook of ['class="body"', 'class="eyes-open"', 'class="eyes-closed" display="none"']) assert.ok(svg.includes(hook), `${avatar}: ${hook}`);
    // The pages' CSP allows no inline style, and a page holds one drawing's ids at a time.
    assert.doesNotMatch(svg, /style[=>]|<style|<script|\bon[a-z]+=|href=/u, avatar);
    for (const [, id] of svg.matchAll(/\bid="([^"]+)"/gu)) assert.ok(id!.startsWith(`${avatar}-`), `${avatar}: ${id}`);
    assert.equal(decodeURIComponent(avatarUrl(avatar).replace('data:image/svg+xml,', '')), svg);
  }
});

test('the default Cat is the drawing the app icons come from', () => {
  const icon = readFileSync(new URL('../../src/renderer/cat.svg', import.meta.url), 'utf8');
  const shapes = (svg: string) => [...svg.matchAll(/<(?:path|ellipse|circle)\b[^>]*\/>/gu)].map(([shape]) => shape);
  const drawn = shapes(avatarSvg(DEFAULT_BOT_AVATAR));
  // In drawing order. The icon has open eyes only, so the closed ones are the drawing's only addition.
  const closed = shapes(/<g class="eyes-closed".*?<\/g>/u.exec(avatarSvg(DEFAULT_BOT_AVATAR))![0]);
  assert.deepEqual(drawn.filter((shape) => !closed.includes(shape)), shapes(icon));
});
