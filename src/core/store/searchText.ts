import { createHash } from 'node:crypto';

/**
 * SPEC-014 FR-8: the text side of the full-text index.
 *
 * SQLite's `unicode61` tokenizer splits on the spaces and punctuation it knows, which stop at
 * an old version of Unicode: an emoji written against a word becomes part of it, a run of
 * Chinese, Japanese or Korean letters is one long token, and full-width or decomposed forms
 * are different words. So every entry is indexed as `indexText` rewrites it, and a query is
 * rewritten the same way:
 *
 * - characters that are never shown, such as a zero-width space, are dropped;
 * - a symbol, or a number that is neither a plain digit nor raised or lowered, stands apart
 *   from the words beside it, so that `iPhone™` holds `iphone` and `①apple` holds `apple`;
 * - compatibility forms are folded together (NFKC) and letters are lower-cased;
 * - whatever is then not a letter, a number or a mark is a space;
 * - each CJK run becomes its overlapping two-character tokens, followed by its last character.
 *
 * The last character does two things. Any one character can be found through the index: it is
 * either the first of a two-character token or the last of its run, so a prefix query reaches
 * it. And it ends the run, so a phrase cannot match across what separated two runs.
 */

/**
 * To be raised, once a release has shipped an index, whenever `indexText` would give another
 * result for the same text. The store rebuilds an index that was made with a different number.
 * 2: each entry's terms end with its conversation's term (PLAN-014 task 1.7).
 */
export const INDEX_FORM = 2;

/**
 * PLAN-014 task 1.7: the term an entry's conversation adds to its terms, so that the index
 * itself narrows a search to one conversation. Letters and digits only, which the tokenizer
 * keeps as one token, and a prefix no rewritten text begins a token with.
 */
export function conversationTerm(conversationId: string): string {
  return `zc${createHash('sha256').update(conversationId).digest('hex').slice(0, 24)}`;
}

/** A query longer than this is refused: nobody searches for a page of text. */
export const MAX_QUERY_LENGTH = 200;
/** And one with more words than this. */
export const MAX_QUERY_WORDS = 12;

const from = (first: number, last: number): string =>
  `${String.fromCharCode(first)}-${String.fromCharCode(last)}`;

/** A byte-order mark: found where two texts were joined, so it separates them. */
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const IGNORABLE = /\p{Default_Ignorable_Code_Point}+/gu;
const SEPARATORS = /[^\p{L}\p{N}\p{M}]+/gu;
const CJK_SCRIPTS = String.raw`\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Bopomofo}`;
/** One letter or number of those scripts; marks of theirs are not characters of a run. */
const CJK_CHARACTER = String.raw`(?=[\p{L}\p{N}])[${CJK_SCRIPTS}]`;
const CJK_RUN = new RegExp(`(?:${CJK_CHARACTER})+`, 'gu');
const CJK_RUNS_KEPT = new RegExp(`((?:${CJK_CHARACTER})+)`, 'u');
/**
 * The dot Chinese writes between the parts of a foreign name, as in `馬克·吐溫`. Inside a CJK
 * run it is dropped, so the name is found with the dot and without it. The dot Japanese
 * writes between the items of a list is another character, and stays a separator.
 */
const NAME_DOT = new RegExp(
  `(?<=${CJK_CHARACTER})[${String.fromCharCode(0x00b7, 0x2027)}]+(?=${CJK_CHARACTER})`,
  'gu',
);
/** Digits written raised or lowered, as in `CO₂` and `m²`: part of the word they follow. */
const RAISED_OR_LOWERED = `${String.fromCharCode(0x00b2, 0x00b3, 0x00b9)}${from(0x2070, 0x209f)}`;
/**
 * What stands apart from the words beside it, so that spelling it out cannot join two of
 * them: a symbol, and a number that is not a plain digit, such as a circled one or a Roman
 * numeral. A number of a CJK run, as the ideographic zero is, stays in its run.
 */
const STANDS_APART = new RegExp(
  String.raw`\p{S}|(?![${CJK_SCRIPTS}${RAISED_OR_LOWERED}])[\p{No}\p{Nl}]`,
  'gu',
);
/**
 * Where one typed word ends and the next begins: a space, and the punctuation of CJK text,
 * which lists things as a comma or a space does elsewhere.
 */
const WORD_BREAK = new RegExp(
  String.raw`(?:\s|(?![\p{L}\p{N}\p{M}])[${from(0x3000, 0x303f)}${from(0xfe30, 0xfe6f)}${from(0xff00, 0xff65)}${String.fromCharCode(0x30fb)}])+`,
  'u',
);
/** Half-width Hangul letters, which NFKC would turn into the kind that joins into syllables. */
const HALF_WIDTH_HANGUL = new RegExp(`[${from(0xffa1, 0xffdc)}]`, 'gu');
/**
 * Everything but the Hangul letters people type on their own, as in `ㅋㅋㅋ`. NFKC would turn
 * those too into the joining kind, and a consonant and a vowel side by side would become one
 * character that neither of them finds.
 */
const NOT_HANGUL_LETTERS = new RegExp(`[^${from(0x3131, 0x318e)}]+`, 'gu');
/**
 * Marks the tokenizer would make nothing of: one with no letter before it, and one after a
 * CJK character, which NFKC has already joined to it wherever the two make one character.
 */
const STRAY_MARKS = new RegExp(
  String.raw`(?<![\p{L}\p{N}\p{M}])\p{M}+|(?<=${CJK_CHARACTER})\p{M}+`,
  'gu',
);

/** A half-width Hangul letter as the full-width letter it stands for. */
function fullWidthHangul(letter: string): string {
  const code = letter.charCodeAt(0);
  // Consonants are one block; vowels come in four groups of six, six, six and three.
  for (const [first, last, target] of [
    [0xffa1, 0xffbe, 0x3131],
    [0xffc2, 0xffc7, 0x314f],
    [0xffca, 0xffcf, 0x3155],
    [0xffd2, 0xffd7, 0x315b],
    [0xffda, 0xffdc, 0x3161],
  ] as const) {
    if (code >= first && code <= last) return String.fromCharCode(code - first + target);
  }
  return letter;
}

/** Text holding nothing but letters, numbers, the marks on them, and spaces. */
function normalise(text: string): string {
  return text
    .replaceAll(BYTE_ORDER_MARK, ' ')
    .replace(IGNORABLE, '')
    .replace(NAME_DOT, '')
    .replace(STANDS_APART, ' $& ')
    .replace(HALF_WIDTH_HANGUL, fullWidthHangul)
    .replace(NOT_HANGUL_LETTERS, (part) => part.normalize('NFKC'))
    .toLowerCase()
    .replace(SEPARATORS, ' ')
    .replace(STRAY_MARKS, '');
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

type Piece = { run: string[] } | { token: string };

/**
 * Turns what a person typed into an FTS5 query, or null when it holds nothing to look for.
 *
 * Every word typed must be present. A word is what stands between spaces or CJK punctuation,
 * and also what stands on either side of any punctuation next to a CJK run: `公園、牙醫` and
 * `LINE、Telegram` each ask for both, anywhere.
 * Each word is one phrase of the tokens the rewriting gives it: `v1.2.3` asks for `v1`, `2`
 * and `3` next to each other, `iPhone拍照` for `iphone` followed by `拍照`. A word that ends in
 * a single CJK character asks for any token starting with it. Nothing typed is read as query
 * syntax, since only letters, numbers and marks reach the query.
 */
export function buildSearchQuery(input: string): string | null {
  if (input.length > MAX_QUERY_LENGTH) {
    throw new RangeError(`A search takes at most ${MAX_QUERY_LENGTH} characters`);
  }
  // The same word twice asks for nothing more, and costs as much again.
  const phrases = new Set<string>();
  for (const typed of input
    .replaceAll(BYTE_ORDER_MARK, ' ')
    .replace(IGNORABLE, '')
    .split(WORD_BREAK)) {
    for (const word of words(typed)) phrases.add(phrase(word));
  }
  if (phrases.size > MAX_QUERY_WORDS) {
    throw new RangeError(`A search takes at most ${MAX_QUERY_WORDS} different words`);
  }
  return phrases.size > 0 ? [...phrases].join(' AND ') : null;
}

/** The words in what was typed between two spaces, each as the pieces it is made of. */
function words(typed: string): Piece[][] {
  const found: Piece[][] = [];
  let previousEndsInRun = false;
  // Every space left here stands for punctuation.
  for (const stretch of normalise(typed).split(' ')) {
    // Odd parts are CJK runs; even parts are whatever stands between them.
    const pieces: Piece[] = [];
    stretch.split(CJK_RUNS_KEPT).forEach((part, index) => {
      if (part === '') return;
      pieces.push(index % 2 === 1 ? { run: Array.from(part) } : { token: part });
    });
    if (pieces.length === 0) continue;
    const startsWithRun = 'run' in pieces[0]!;
    // Punctuation inside Latin text keeps the word together; next to a CJK run it parts two words.
    if (found.length > 0 && !previousEndsInRun && !startsWithRun) found.at(-1)!.push(...pieces);
    else found.push(pieces);
    previousEndsInRun = 'run' in pieces.at(-1)!;
  }
  return found;
}

function phrase(pieces: Piece[]): string {
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
  return `"${tokens.join(' ')}"${prefix ? '*' : ''}`;
}
