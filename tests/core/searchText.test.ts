import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildSearchQuery,
  indexText,
  MAX_QUERY_LENGTH,
  MAX_QUERY_WORDS,
} from '../../src/core/store/searchText.ts';

/** SPEC-014 FR-8: how an entry's text and a person's query are rewritten for the index. */

const tokens = (text: string): string[] => indexText(text).split(' ').filter(Boolean);

test('a CJK run becomes its two-character tokens and then its last character', () => {
  assert.deepEqual(tokens('明天去公園散步'), [
    '明天',
    '天去',
    '去公',
    '公園',
    '園散',
    '散步',
    '步',
  ]);
  assert.deepEqual(tokens('園'), ['園']);
  assert.deepEqual(tokens('plain English kettle'), ['plain', 'english', 'kettle']);
  // A Latin word written against a run is a word of its own.
  assert.deepEqual(tokens('用iPhone拍照'), ['用', 'iphone', '拍照', '照']);
  assert.deepEqual(tokens('版本v1.2.3更新'), ['版本', '本', 'v1', '2', '3', '更新', '新']);
  // Punctuation ends a run instead of joining two words.
  assert.deepEqual(tokens('牙醫，公園。'), ['牙醫', '醫', '公園', '園']);
  assert.deepEqual(tokens('「你好」'), ['你好', '好']);
  assert.deepEqual(tokens(''), []);
});

test('Japanese, Korean and Bopomofo runs are split the same way', () => {
  // The long-vowel mark belongs to the word.
  assert.deepEqual(tokens('コーヒーを飲む'), [
    'コー',
    'ーヒ',
    'ヒー',
    'ーを',
    'を飲',
    '飲む',
    'む',
  ]);
  assert.deepEqual(tokens('한국어 공부'), ['한국', '국어', '어', '공부', '부']);
  assert.deepEqual(tokens('ㄏㄏㄏ'), ['ㄏㄏ', 'ㄏㄏ', 'ㄏ']);
  assert.deepEqual(tokens('好ㄉ'), ['好ㄉ', 'ㄉ']);
});

test('a character outside the Basic Multilingual Plane counts as one character', () => {
  const rare = String.fromCodePoint(0x20000);
  assert.deepEqual(tokens(`${rare}字典`), [`${rare}字`, '字典', '典']);
  assert.deepEqual(tokens(rare), [rare]);
  assert.equal(buildSearchQuery(rare), `"${rare}"*`);
  assert.equal(buildSearchQuery(`${rare}字`), `"${rare}字"`);
});

test('what is not a letter, a number or a mark separates words, whatever Unicode it came with', () => {
  // The tokenizer's own table is older than these, and would keep them as part of a word.
  assert.deepEqual(tokens(`OK${String.fromCodePoint(0x1f642)}`), ['ok']);
  assert.deepEqual(tokens(`這個bug${String.fromCodePoint(0x1f914)}怎麼修`), [
    '這個',
    '個',
    'bug',
    '怎麼',
    '麼修',
    '修',
  ]);
  assert.deepEqual(tokens(`100${String.fromCodePoint(0x1f973)}`), ['100']);
  assert.deepEqual(tokens(`${String.fromCodePoint(0x1f642)} !? ...`), []);
  assert.deepEqual(tokens("don't stop"), ['don', 't', 'stop']);
});

test('compatibility forms, decomposed forms and characters never shown do not hide a word', () => {
  // Full-width digits and letters, and half-width Katakana.
  assert.deepEqual(tokens('２０２６年'), ['2026', '年']);
  assert.deepEqual(tokens('訂單編號ＡＢ１２３'), ['訂單', '單編', '編號', '號', 'ab123']);
  assert.deepEqual(tokens('ｺｰﾋｰ'), tokens('コーヒー'));
  // A voiced kana written as two code points, as macOS file names are.
  const decomposed = `か${String.fromCharCode(0x3099)}っこう`;
  assert.notEqual(decomposed, 'がっこう');
  assert.deepEqual(tokens(decomposed), tokens('がっこう'));
  // A zero-width space, a soft hyphen and a byte-order mark inside a word.
  for (const hidden of [0x200b, 0x00ad, 0xfeff, 0x2060]) {
    assert.deepEqual(tokens(`ket${String.fromCharCode(hidden)}tle`), ['kettle']);
  }
  // A variation selector after a Han character.
  assert.deepEqual(tokens(`葛${String.fromCodePoint(0xe0100)}飾`), ['葛飾', '飾']);
});

test('each word typed becomes one phrase of the tokens it would be indexed as', () => {
  assert.equal(buildSearchQuery('公園'), '"公園"');
  assert.equal(buildSearchQuery('去公園'), '"去公 公園"');
  assert.equal(buildSearchQuery('牙醫 公園'), '"牙醫" AND "公園"');
  assert.equal(buildSearchQuery('KETTLE'), '"kettle"');
  assert.equal(buildSearchQuery('  Pro   MacBook '), '"pro" AND "macbook"');
  assert.equal(buildSearchQuery('v1.2.3'), '"v1 2 3"');
  assert.equal(buildSearchQuery('２０２６'), '"2026"');
  // A word that mixes scripts keeps its order: `iphone` and then `拍照`.
  assert.equal(buildSearchQuery('iPhone拍照'), '"iphone 拍照"');
  // A run with more of the word after it must end there in the entry as well.
  assert.equal(buildSearchQuery('公園abc'), '"公園 園 abc"');
  assert.equal(buildSearchQuery('a股b'), '"a 股 b"');
});

test('a word that ends in one CJK character asks for any token starting with it', () => {
  assert.equal(buildSearchQuery('園'), '"園"*');
  assert.equal(buildSearchQuery('A股'), '"a 股"*');
  assert.equal(buildSearchQuery('園 步'), '"園"* AND "步"*');
  assert.equal(buildSearchQuery('園 kettle'), '"園"* AND "kettle"');
});

test('nothing a person types is read as query syntax', () => {
  assert.equal(buildSearchQuery('say "hello" OR NOT'), '"say" AND "hello" AND "or" AND "not"');
  assert.equal(buildSearchQuery('terms:kettle*'), '"terms kettle"');
  assert.equal(buildSearchQuery('(a) -b ^c NEAR/2'), '"a" AND "b" AND "c" AND "near 2"');
  // A NUL character would end the query where the index reads it.
  assert.equal(buildSearchQuery(`alpha${String.fromCharCode(0)}omega`), '"alpha omega"');
  assert.equal(
    buildSearchQuery(`lone ${String.fromCharCode(0xd83d)} surrogate`),
    '"lone" AND "surrogate"',
  );
});

test('input with nothing to look for gives no query, and a page of text is refused', () => {
  assert.equal(buildSearchQuery(''), null);
  assert.equal(buildSearchQuery('   \n\t'), null);
  assert.equal(buildSearchQuery('，。!? ... --'), null);
  assert.equal(buildSearchQuery(String.fromCodePoint(0x1f642)), null);

  assert.equal(typeof buildSearchQuery('貓'.repeat(MAX_QUERY_LENGTH)), 'string');
  assert.throws(() => buildSearchQuery('貓'.repeat(MAX_QUERY_LENGTH + 1)), RangeError);
  const words = (count: number): string =>
    Array.from({ length: count }, (_, index) => `w${index}`).join(' ');
  assert.equal(buildSearchQuery(words(MAX_QUERY_WORDS))?.split(' AND ').length, MAX_QUERY_WORDS);
  assert.throws(() => buildSearchQuery(words(MAX_QUERY_WORDS + 1)), RangeError);
});
