/**
 * SPEC-014 FR-8: the text side of the full-text index.
 *
 * SQLite's `unicode61` tokenizer splits on spaces and punctuation only. A run of Chinese,
 * Japanese or Korean letters is one long token to it, and so is a Latin word written next
 * to such a run without a space, so neither a word inside the run nor that Latin word can
 * be found. Every entry is therefore indexed as `indexText` rewrites it: each run becomes
 * overlapping two-character tokens, set apart from the text around it. A query is rewritten
 * the same way.
 */

/** A run of Han, Kana or Hangul letters. Punctuation of those scripts ends a run. */
const CJK_RUN = /(?:(?=\p{L})[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}])+/gu;
/** What `unicode61` makes tokens of. A word without any is punctuation only. */
const TOKEN_CHARACTER = /[\p{L}\p{N}\p{Co}]/u;

/** The text to index for an entry: CJK runs as two-character tokens, the rest unchanged. */
export function indexText(text: string): string {
  return text.replace(CJK_RUN, (run) => ` ${bigrams(run).join(' ')} `);
}

function bigrams(run: string): string[] {
  // By code point: a character outside the Basic Multilingual Plane is two UTF-16 units.
  const characters = Array.from(run);
  if (characters.length < 2) return characters;
  return characters.slice(0, -1).map((character, index) => character + characters[index + 1]!);
}

export interface SearchQuery {
  /** An FTS5 query for `entries_fts`, or null when no part of the input can use the index. */
  match: string | null;
  /**
   * Single CJK characters. Inside a longer run they are not tokens, so each is looked for
   * with a substring test on the entry's text instead (FR-8).
   */
  contains: string[];
}

/**
 * Turns what a person typed into a query. Every word must be present: a CJK run of two or
 * more characters as a phrase of its two-character tokens, and any other word as the
 * tokenizer reads it. Returns null when the input holds nothing to look for.
 */
export function buildSearchQuery(input: string): SearchQuery | null {
  const phrases: string[] = [];
  const contains: string[] = [];
  let rest = '';
  let end = 0;
  for (const found of input.matchAll(CJK_RUN)) {
    rest += `${input.slice(end, found.index)} `;
    end = found.index + found[0].length;
    const tokens = bigrams(found[0]);
    if (Array.from(found[0]).length < 2) contains.push(found[0]);
    else phrases.push(quote(tokens.join(' ')));
  }
  rest += input.slice(end);
  // The tokenizer splits a quoted word the way it split the entry, so `v1.2` stays a phrase.
  for (const word of rest.split(/\s+/u)) {
    if (TOKEN_CHARACTER.test(word)) phrases.push(quote(word));
  }
  if (phrases.length === 0 && contains.length === 0) return null;
  return {
    match: phrases.length > 0 ? phrases.join(' AND ') : null,
    contains: [...new Set(contains)],
  };
}

/** An FTS5 string: a phrase of the tokens inside it, with nothing read as query syntax. */
function quote(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

/** The pattern for `like ... escape '\'` that finds `text` as a substring. */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/gu, (character) => `\\${character}`)}%`;
}
