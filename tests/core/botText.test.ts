import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BOT_NAME_MAX,
  BOT_PERSONA_MAX,
  botNameProblem,
  botPersonaProblem,
  checkedBotName,
  checkedBotPersona,
  normalizeBotPersona,
  oneLine,
} from '../../src/shared/botText.ts';

/** Printable ASCII "hi", spelled in the Unicode tag characters a model can read and a person cannot see. */
const HIDDEN_TAGS = String.fromCodePoint(0xE0068, 0xE0069);

test('a name is 1 to 40 units on one line, with something that shows (SPEC-010 FR-19)', () => {
  for (const name of ['Mochi', '麻糬', 'R2-D2', 'A&B <script>', '🐈', 'x'.repeat(BOT_NAME_MAX)]) {
    assert.equal(botNameProblem(name), null, name);
  }
  assert.equal(botNameProblem(''), 'empty');
  assert.equal(botNameProblem('x'.repeat(BOT_NAME_MAX + 1)), 'too_long');
  assert.equal(botNameProblem('\uD800'), 'malformed');
  assert.equal(botNameProblem('á'), null, 'a combining mark on a letter is fine');
  assert.equal(botNameProblem('́'), 'no_visible', 'a mark with nothing under it shows nothing');
});

test('a name refuses each kind of character that would forge a line or hide', () => {
  const refused = {
    'line feed': 'a\nb',
    'carriage return': 'a\rb',
    tab: 'a\tb',
    nul: 'a\0b',
    escape: 'a\u001Bb',
    'line separator': 'a\u2028b',
    'paragraph separator': 'a\u2029b',
    'zero width space': 'a\u200Bb',
    'zero width joiner': 'a\u200Db',
    'right-to-left override': 'a\u202Eb',
    'tag characters': `a${HIDDEN_TAGS}`,
    'byte order mark': 'a\uFEFFb',
    'braille blank': 'a\u2800b',
    'hangul filler': 'a\u3164b',
  };
  for (const [label, name] of Object.entries(refused)) {
    assert.equal(botNameProblem(name), 'hidden', label);
  }
});

test('a persona is at most 4,000 units and may have lines and tabs', () => {
  assert.equal(botPersonaProblem(''), null, 'a persona is optional');
  assert.equal(botPersonaProblem('First line\n\n\tSecond line'), null);
  assert.equal(botPersonaProblem('Reply in English & keep it short <b>"please"</b>; 100% $HOME %PATH%'), null);
  assert.equal(botPersonaProblem('x'.repeat(BOT_PERSONA_MAX)), null);
  assert.equal(botPersonaProblem('x'.repeat(BOT_PERSONA_MAX + 1)), 'too_long');
  assert.equal(botPersonaProblem('\uDC00'), 'malformed');
});

test('a persona keeps the joiners emoji and some scripts need', () => {
  assert.equal(botPersonaProblem('👩\u200D💻 likes tea'), null, 'zero width joiner');
  assert.equal(botPersonaProblem('می\u200Cخواهم'), null, 'zero width non-joiner');
  assert.equal(botPersonaProblem('❤️'), null, 'a variation selector is not a format character');
});

test('a persona refuses text its owner cannot see', () => {
  const refused = {
    nul: 'a\0b',
    escape: 'a\u001Bb',
    backspace: 'a\bb',
    'line separator': 'a\u2028b',
    'zero width space': 'a\u200Bb',
    'left-to-right mark': 'a\u200Eb',
    'right-to-left override': 'a\u202Eb',
    'first strong isolate': 'a\u2068b',
    'tag characters': `Be kind.${HIDDEN_TAGS}`,
    'interlinear annotation': 'a\uFFF9b',
    'soft hyphen': 'a\u00ADb',
  };
  for (const [label, persona] of Object.entries(refused)) {
    assert.equal(botPersonaProblem(persona), 'hidden', label);
  }
});

test('line endings are normalized and surrounding space goes before the rule applies', () => {
  assert.equal(normalizeBotPersona('  a\r\nb\rc\n  '), 'a\nb\nc');
  assert.equal(checkedBotPersona('  a\r\nb  '), 'a\nb');
  assert.equal(checkedBotName('  Mochi　'), 'Mochi');
});

test('the checked forms refuse with a message that says why', () => {
  assert.throws(() => checkedBotName('   '), /Give the cat bot a name/u);
  assert.throws(() => checkedBotName('x'.repeat(41)), /at most 40 characters/u);
  assert.throws(() => checkedBotName('a\nb'), /line breaks or characters that do not show/u);
  assert.throws(() => checkedBotPersona('x'.repeat(4_001)), /at most 4,000 characters/u);
  assert.throws(() => checkedBotPersona(`hi${HIDDEN_TAGS}`), /do not show/u);
});

test('one line removes what does not show and shortens by characters', () => {
  assert.equal(oneLine(`  a\n\tb${HIDDEN_TAGS}  c\u200B `, 80), 'a b c');
  assert.equal(oneLine('🐈🐈🐈🐈', 3), '🐈🐈…');
});
