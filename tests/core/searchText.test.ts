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
const character = (codePoint: number): string => String.fromCodePoint(codePoint);

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
  // Hangul letters typed on their own stay letters: joined into syllables, a consonant and
  // the vowel after it would become one character that neither of them finds.
  assert.deepEqual(tokens('ㅋㅋㅋㅠㅠ'), ['ㅋㅋ', 'ㅋㅋ', 'ㅋㅠ', 'ㅠㅠ', 'ㅠ']);
  assert.equal(buildSearchQuery('ㅋㅋㅋ'), '"ㅋㅋ ㅋㅋ"');
  assert.equal(buildSearchQuery('ㅠㅠ'), '"ㅠㅠ"');
  assert.deepEqual(tokens('아니 ㄴㄴㅠ'), ['아니', '니', 'ㄴㄴ', 'ㄴㅠ', 'ㅠ']);
  // Their half-width forms are the same letters. Each is checked against the full-width
  // letter that Unicode decomposes to the same joining letter.
  let halfWidth = 0;
  for (let code = 0xffa1; code <= 0xffdc; code += 1) {
    const letter = String.fromCharCode(code);
    if (letter.normalize('NFKC') === letter) continue;
    halfWidth += 1;
    const fullWidth = Array.from({ length: 0x318e - 0x3131 + 1 }, (_, index) =>
      String.fromCharCode(0x3131 + index),
    ).find((candidate) => candidate.normalize('NFKD') === letter.normalize('NFKD'));
    assert.deepEqual(tokens(letter), [fullWidth], code.toString(16));
  }
  assert.equal(halfWidth, 51);
});

test('a character outside the Basic Multilingual Plane counts as one character', () => {
  const rare = character(0x20000);
  assert.deepEqual(tokens(`${rare}字典`), [`${rare}字`, '字典', '典']);
  assert.deepEqual(tokens(rare), [rare]);
  assert.equal(buildSearchQuery(rare), `"${rare}"*`);
  assert.equal(buildSearchQuery(`${rare}字`), `"${rare}字"`);
});

test('what is not a letter, a number or a mark separates words, whatever Unicode it came with', () => {
  // The tokenizer's own table is older than these, and would keep them as part of a word.
  assert.deepEqual(tokens(`OK${character(0x1f642)}`), ['ok']);
  assert.deepEqual(tokens(`這個bug${character(0x1f914)}怎麼修`), [
    '這個',
    '個',
    'bug',
    '怎麼',
    '麼修',
    '修',
  ]);
  assert.deepEqual(tokens(`100${character(0x1f973)}`), ['100']);
  assert.deepEqual(tokens(`${character(0x1f642)} !? ...`), []);
  assert.deepEqual(tokens("don't stop"), ['don', 't', 'stop']);
  // A symbol stands apart from the word beside it, so that spelling it out cannot glue the
  // two together: a trade mark sign would otherwise make `iphonetm` of the word before it.
  assert.deepEqual(tokens('iPhone™'), ['iphone', 'tm']);
  assert.deepEqual(tokens('℡0912345678'), ['tel', '0912345678']);
  assert.deepEqual(tokens('№1 Ⓐplan Bot℠'), ['no', '1', 'a', 'plan', 'bot', 'sm']);
  assert.deepEqual(tokens('5㎏ 50㎡'), ['5', 'kg', '50', 'm2']);
  assert.deepEqual(tokens('㋿8年'), ['令和', '和', '8', '年']);
  // So does a number that is not a plain digit.
  assert.deepEqual(tokens('①apple ②banana'), ['1', 'apple', '2', 'banana']);
  // A digit written raised or lowered is part of the word it follows.
  assert.deepEqual(tokens('E=mc²'), ['e', 'mc2']);
  assert.deepEqual(tokens('CO₂ and H₂O'), ['co2', 'and', 'h2o']);
  assert.deepEqual(tokens('m²'), tokens('㎡'));
  assert.deepEqual(tokens('Final FantasyⅦ'), ['final', 'fantasy', 'vii']);
  assert.deepEqual(tokens('½ cup'), ['1', '2', 'cup']);
  // The ideographic zero is a character of its run.
  assert.deepEqual(tokens('二〇二六年'), ['二〇', '〇二', '二六', '六年', '年']);
  // A face made of marks and symbols is nothing to look for.
  assert.deepEqual(tokens('今天好開心 (￣▽￣)'), ['今天', '天好', '好開', '開心', '心']);
  assert.deepEqual(tokens('kettle ´ teapot'), ['kettle', 'teapot']);
});

test('compatibility forms, decomposed forms and characters never shown do not hide a word', () => {
  // Full-width digits and letters, and half-width Katakana.
  assert.deepEqual(tokens('２０２６年'), ['2026', '年']);
  assert.deepEqual(tokens('訂單編號ＡＢ１２３'), ['訂單', '單編', '編號', '號', 'ab123']);
  assert.deepEqual(tokens('ｺｰﾋｰ'), tokens('コーヒー'));
  // A voiced kana written as two code points, as macOS file names are.
  const decomposed = `か${character(0x3099)}っこう`;
  assert.notEqual(decomposed, 'がっこう');
  assert.deepEqual(tokens(decomposed), tokens('がっこう'));
  // A mark that joins nothing is dropped, in a run and at the start of a word.
  assert.deepEqual(tokens(`じゃあ${character(0x3099)}`), ['じゃ', 'ゃあ', 'あ']);
  assert.equal(buildSearchQuery(`あ${character(0x3099)}`), '"あ"*');
  assert.deepEqual(tokens(`${character(0x0301)}kettle`), ['kettle']);
  // A zero-width space, a soft hyphen and a word joiner inside a word.
  for (const hidden of [0x200b, 0x00ad, 0x2060]) {
    assert.deepEqual(tokens(`ket${character(hidden)}tle`), ['kettle']);
    assert.equal(buildSearchQuery(`ket${character(hidden)}tle`), '"kettle"');
  }
  // A byte-order mark is where two texts were joined: it separates them, on both sides.
  assert.deepEqual(tokens(`first line${character(0xfeff)}second line`), [
    'first',
    'line',
    'second',
    'line',
  ]);
  assert.equal(buildSearchQuery(`line${character(0xfeff)}second`), '"line" AND "second"');
  // A variation selector after a Han character.
  assert.deepEqual(tokens(`葛${character(0xe0100)}飾`), ['葛飾', '飾']);
});

test('each word typed becomes one phrase of the tokens it would be indexed as', () => {
  assert.equal(buildSearchQuery('公園'), '"公園"');
  assert.equal(buildSearchQuery('去公園'), '"去公 公園"');
  assert.equal(buildSearchQuery('牙醫 公園'), '"牙醫" AND "公園"');
  assert.equal(buildSearchQuery('KETTLE'), '"kettle"');
  assert.equal(buildSearchQuery('  Pro   MacBook '), '"pro" AND "macbook"');
  assert.equal(buildSearchQuery('２０２６'), '"2026"');
  // Punctuation inside Latin text keeps a word together.
  assert.equal(buildSearchQuery('v1.2.3'), '"v1 2 3"');
  assert.equal(buildSearchQuery("don't"), '"don t"');
  // A word that mixes scripts keeps its order: `iphone` and then `拍照`.
  assert.equal(buildSearchQuery('iPhone拍照'), '"iphone 拍照"');
  // A run with more of the word after it must end there in the entry as well.
  assert.equal(buildSearchQuery('公園abc'), '"公園 園 abc"');
  assert.equal(buildSearchQuery('a股b'), '"a 股 b"');
});

test('CJK punctuation, and any punctuation next to a CJK run, parts two words as a space does', () => {
  assert.equal(buildSearchQuery('公園、牙醫'), '"公園" AND "牙醫"');
  assert.equal(buildSearchQuery('公園，然後牙醫。'), '"公園" AND "然後 後牙 牙醫"');
  assert.equal(buildSearchQuery('kettle,茶壺'), '"kettle" AND "茶壺"');
  assert.equal(buildSearchQuery('茶壺(kettle)'), '"茶壺" AND "kettle"');
  assert.equal(buildSearchQuery('茶壺（kettle）'), '"茶壺" AND "kettle"');
  assert.equal(buildSearchQuery('開心 (￣▽￣)'), '"開心"');
  assert.equal(buildSearchQuery('第①章'), '"第"* AND "1" AND "章"*');
  // Between two Latin words as well, where a Latin comma would keep one phrase.
  assert.equal(buildSearchQuery('LINE、Telegram'), '"line" AND "telegram"');
  assert.equal(buildSearchQuery('LINE，Telegram；Signal'), '"line" AND "telegram" AND "signal"');
  assert.equal(buildSearchQuery('LINE・Telegram'), '"line" AND "telegram"');
  // The small forms of CJK punctuation, as a small comma.
  assert.equal(buildSearchQuery(`LINE${character(0xfe50)}Telegram`), '"line" AND "telegram"');
  assert.equal(buildSearchQuery('LINE,Telegram'), '"line telegram"');
  // Full-width letters and digits are not punctuation.
  assert.equal(buildSearchQuery('ＡＢ１２３'), '"ab123"');
  assert.equal(buildSearchQuery('々〇'), '"々〇"');
});

test('the dot Chinese writes inside a name is not a break in it', () => {
  // Written with the dot or without it, the name is the same run.
  for (const dot of [0x00b7, 0x2027]) {
    assert.deepEqual(tokens(`馬克${character(dot)}吐溫的書`), tokens('馬克吐溫的書'));
    assert.equal(buildSearchQuery(`馬克${character(dot)}吐溫`), '"馬克 克吐 吐溫"');
  }
  // The dot Japanese puts between the items of a list is another character, and parts them.
  assert.deepEqual(tokens('東京・大阪'), ['東京', '京', '大阪', '阪']);
  assert.deepEqual(tokens('コーヒー・ショップ'), [
    'コー',
    'ーヒ',
    'ヒー',
    'ー',
    'ショ',
    'ョッ',
    'ップ',
    'プ',
  ]);
  assert.equal(buildSearchQuery('東京・大阪'), '"東京" AND "大阪"');
  // Between Latin letters, and at the end of a run, the dot is punctuation like any other.
  assert.deepEqual(tokens('a·b'), ['a', 'b']);
  assert.deepEqual(tokens('公園·'), ['公園', '園']);
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
  assert.equal(buildSearchQuery(`alpha${character(0)}omega`), '"alpha omega"');
  assert.equal(
    buildSearchQuery(`lone ${String.fromCharCode(0xd83d)} surrogate`),
    '"lone" AND "surrogate"',
  );
});

test('the same word twice is asked for once, and a long search is refused', () => {
  assert.equal(buildSearchQuery('的 的 的'), '"的"*');
  assert.equal(buildSearchQuery('kettle Kettle KETTLE teapot'), '"kettle" AND "teapot"');

  assert.equal(buildSearchQuery(''), null);
  assert.equal(buildSearchQuery('   \n\t'), null);
  assert.equal(buildSearchQuery('，。!? ... --'), null);
  assert.equal(buildSearchQuery(character(0x1f642)), null);

  assert.equal(typeof buildSearchQuery('貓'.repeat(MAX_QUERY_LENGTH)), 'string');
  assert.throws(() => buildSearchQuery('貓'.repeat(MAX_QUERY_LENGTH + 1)), RangeError);
  const different = (count: number): string =>
    Array.from({ length: count }, (_, index) => `w${index}`).join(' ');
  assert.equal(
    buildSearchQuery(different(MAX_QUERY_WORDS))?.split(' AND ').length,
    MAX_QUERY_WORDS,
  );
  assert.throws(() => buildSearchQuery(different(MAX_QUERY_WORDS + 1)), RangeError);
  // Counted after the repeats are gone.
  assert.equal(
    buildSearchQuery(Array.from({ length: MAX_QUERY_WORDS + 5 }, () => 'again').join(' ')),
    '"again"',
  );
});
