/**
 * SPEC-010 FR-19: what a bot's name and persona may hold, for the page, the
 * shell and the core alike. Free of Node and React, so all three can use it.
 *
 * A name reaches window titles, dialogs, logs and a heartbeat prompt, so it is
 * one line whose every character shows. A persona is the owner's own instruction
 * to their cat bot, so what it asks for is not judged. It only must not carry
 * text the owner cannot see, as pasted text can: tag characters and variation
 * selectors spell out a hidden instruction a model still reads, and direction marks
 * reorder what the owner reads.
 *
 * A value that breaks the rule is refused, never quietly changed: stripping
 * hidden text would also hide that it was there.
 */

export const BOT_NAME_MAX = 40;
export const BOT_PERSONA_MAX = 4_000;

export type BotTextProblem = 'empty' | 'too_long' | 'malformed' | 'hidden' | 'no_visible';

/** A surrogate with no partner: valid in a JS string, not in UTF-8. */
const MALFORMED = /\p{Cs}/u;
/**
 * Controls, format characters, line and paragraph separators, the Braille blank and what never shows:
 * Default_Ignorable_Code_Point. U+FE0E and U+FE0F stay out of that right after an emoji or symbol,
 * because they choose how it shows. Anywhere else they spell out text a model still reads.
 */
const NOT_PLAIN = /[\p{Cc}\p{Cf}\u2028\u2029\u2800]|[^\P{DI}\uFE0E\uFE0F]|(?<![\p{Emoji}\p{S}])[\uFE0E\uFE0F]/u;
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;
/**
 * Controls but line feed and tab, separators, and format characters and what never shows, but the
 * emoji selectors above and the joiners that emoji and some scripts need (U+200C, U+200D), right
 * after something that shows or a mark. A selector is a mark, so an emoji sequence can join after it.
 */
const PERSONA_HIDDEN = /[^\P{Cc}\n\t]|[^\P{Cf}\u200C\u200D]|[\u2028\u2029]|[^\P{DI}\u200C\u200D\uFE0E\uFE0F]|(?<![\p{Emoji}\p{S}])[\uFE0E\uFE0F]|(?<![\p{L}\p{M}\p{N}\p{P}\p{S}])[\u200C\u200D]/u;

/** Characters that do not show: format characters, what never shows, and the Braille blank. */
const UNSEEN = /[\p{Cf}\u2800]|[^\P{DI}\uFE0E\uFE0F]/gu;
const LINE_BREAKS = /[\p{Cc}\u2028\u2029]+/gu;

/** Whether `value` is one line whose every character shows, as a name the owner reads in a dialog must be. */
export function isPlainLine(value: string): boolean {
  return !NOT_PLAIN.test(value);
}

/**
 * Text a bot or its model wrote, or an older profile holds, made fit for one line
 * of a dialog, a log or a prompt: characters that do not show removed, line breaks
 * and control characters made spaces, whitespace collapsed, at most `max` characters.
 */
export function oneLine(value: string, max: number): string {
  const flat = value.replace(UNSEEN, '').replace(LINE_BREAKS, ' ').replace(/\s+/gu, ' ').trim();
  const characters = [...flat];
  return characters.length <= max ? flat : `${characters.slice(0, Math.max(0, max - 1)).join('')}…`;
}

export function normalizeBotName(value: string): string {
  return value.trim();
}

export function normalizeBotPersona(value: string): string {
  return value.replace(/\r\n?/gu, '\n').trim();
}

/** What is wrong with a name, already normalized; null when nothing is. */
export function botNameProblem(name: string): BotTextProblem | null {
  if (!name) return 'empty';
  if (name.length > BOT_NAME_MAX) return 'too_long';
  if (MALFORMED.test(name)) return 'malformed';
  if (!isPlainLine(name)) return 'hidden';
  if (!VISIBLE.test(name)) return 'no_visible';
  return null;
}

/** What is wrong with a persona, already normalized; null when nothing is. An empty one is allowed. */
export function botPersonaProblem(persona: string): BotTextProblem | null {
  if (persona.length > BOT_PERSONA_MAX) return 'too_long';
  if (MALFORMED.test(persona)) return 'malformed';
  if (PERSONA_HIDDEN.test(persona)) return 'hidden';
  return null;
}

/** English text, which is also the translation key. */
export function botNameMessage(problem: BotTextProblem): string {
  switch (problem) {
    case 'empty': return 'Give the cat bot a name';
    case 'too_long': return 'A name has at most 40 characters';
    case 'no_visible': return 'A name needs at least one letter, number or symbol';
    default: return 'A name cannot hold line breaks or characters that do not show';
  }
}

export function botPersonaMessage(problem: BotTextProblem): string {
  return problem === 'too_long'
    ? 'A personality has at most 4,000 characters'
    : 'This personality holds control characters or characters that do not show, often from pasted text. Retype that part.';
}

/** The normalized name, or an error saying what is wrong with it. Anything but text is no name. */
export function checkedBotName(value: unknown): string {
  const name = normalizeBotName(typeof value === 'string' ? value : '');
  const problem = botNameProblem(name);
  if (problem) throw new Error(botNameMessage(problem));
  return name;
}

/** The normalized persona, or an error saying what is wrong with it. */
export function checkedBotPersona(value: unknown): string {
  if (typeof value !== 'string') throw new Error('A personality must be text');
  const persona = normalizeBotPersona(value);
  const problem = botPersonaProblem(persona);
  if (problem) throw new Error(botPersonaMessage(problem));
  return persona;
}
