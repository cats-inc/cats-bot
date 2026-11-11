/**
 * SPEC-014 FR-8: the text side of the full-text index.
 *
 * SQLite's `unicode61` tokenizer splits on the spaces and punctuation it knows, which stop at
 * an old version of Unicode: an emoji written against a word becomes part of it, a run of
 * Chinese, Japanese or Korean letters is one long token, and full-width or decomposed forms
 * are different words. So every entry is indexed as `indexText` rewrites it, and a query is
 * rewritten the same way:
 *
 * - compatibility forms are folded together (NFKC) and letters are lower-cased;
 * - characters that are never shown, such as a zero-width space, are dropped;
 * - whatever is not a letter, a number or a mark becomes a space;
 * - each CJK run becomes its overlapping two-character tokens, followed by its last character.
 *
 * The last character does two things. Any one character can be found through the index: it is
 * either the first of a two-character token or the last of its run, so a prefix query reaches
 * it. And it ends the run, so a phrase cannot match across what separated two runs.
 */

/**
 * Raised whenever `indexText` would give another result for the same text. The store rebuilds
 * an index that was made with a different number.
 */
export const INDEX_FORM = 1;

/** A query longer than this is refused: nobody searches for a page of text. */
export const MAX_QUERY_LENGTH = 1000;
/** And one with more words than this. */
export const MAX_QUERY_WORDS = 32;

const IGNORABLE = /\p{Default_Ignorable_Code_Point}+/gu;
const SEPARATORS = /[^\p{L}\p{N}\p{M}]+/gu;
/** A run of Han, Kana, Hangul or Bopomofo, in text that already holds nothing but letters, numbers, marks and spaces. */
const CJK_RUN = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Bopomofo}]+/gu;
const CJK_RUNS_KEPT = new RegExp(`(${CJK_RUN.source})`, 'u');

function normalise(text: string): string {
  return text.normalize('NFKC').replace(IGNORABLE, '').toLowerCase().replace(SEPARATORS, ' ');
}

/** By code point: a character outside the Basic Multilingual Plane is two UTF-16 units. */
function windows(characters: string[]): string[] {
  return characters.slice(0, -1).map((character, index) => character + characters[index + 1]!);
}

/** The text to index for an entry. */
export function indexText(text: string): string {
  return normalise(text).replace(CJK_RUN, (run) => {
    const characters = Array.from(run);
    return ` ${[...windows(characters), characters.at(-1)!].join(' ')} `;
  });
}

/**
 * Turns what a person typed into an FTS5 query, or null when it holds nothing to look for.
 *
 * Every word typed must be present, each as one phrase of the tokens the rewriting gives it:
 * `v1.2.3` asks for `v1`, `2` and `3` next to each other, `iPhone拍照` for `iphone` followed by
 * `拍照`. A word that ends in a single CJK character asks for any token starting with it.
 * Nothing typed is read as query syntax, since only letters, numbers and marks reach the query.
 */
export function buildSearchQuery(input: string): string | null {
  if (input.length > MAX_QUERY_LENGTH) {
    throw new RangeError(`A search takes at most ${MAX_QUERY_LENGTH} characters`);
  }
  const phrases: string[] = [];
  for (const word of input.split(/\s+/u)) {
    const phrase = wordPhrase(word);
    if (phrase) phrases.push(phrase);
  }
  if (phrases.length > MAX_QUERY_WORDS) {
    throw new RangeError(`A search takes at most ${MAX_QUERY_WORDS} words`);
  }
  return phrases.length > 0 ? phrases.join(' AND ') : null;
}

function wordPhrase(word: string): string | null {
  // Odd parts are CJK runs; even parts are whatever stands between them.
  const parts = normalise(word).split(CJK_RUNS_KEPT);
  const pieces: Array<{ run: string[] } | { token: string }> = [];
  parts.forEach((part, index) => {
    if (index % 2 === 1) pieces.push({ run: Array.from(part) });
    else for (const token of part.split(' ')) if (token) pieces.push({ token });
  });
  const tokens: string[] = [];
  let prefix = false;
  pieces.forEach((piece, index) => {
    if ('token' in piece) {
      tokens.push(piece.token);
    } else if (index < pieces.length - 1) {
      // More of the word follows, so the run must end here in the entry as well.
      tokens.push(...windows(piece.run), piece.run.at(-1)!);
    } else if (piece.run.length > 1) {
      // The entry's run may go on after these characters.
      tokens.push(...windows(piece.run));
    } else {
      tokens.push(piece.run[0]!);
      prefix = true;
    }
  });
  return tokens.length > 0 ? `"${tokens.join(' ')}"${prefix ? '*' : ''}` : null;
}
