import { translate, type LanguageState } from '../shared/language.ts';

let state: LanguageState = { preference: 'system', locale: 'en' };
const listeners = new Set<() => void>();
export const languageSnapshot = () => state;
export const subscribeLanguage = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function acceptLanguage(next: LanguageState): void {
  state = next;
  for (const listener of listeners) listener();
}
export const t = (message: string, values?: Record<string, unknown>) =>
  translate(state.locale, message, values);

/** Translate the built-in direct-message title; preserve owner-assigned titles. */
export const conversationTitle = (record: { role: string; title: string }) =>
  record.role === 'home' && ['Home', 'Direct message'].includes(record.title)
    ? t('Direct message')
    : record.title;
