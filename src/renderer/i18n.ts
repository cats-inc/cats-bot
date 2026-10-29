import { useSyncExternalStore } from 'react';
import type { LanguagePreference, LanguageState } from '../shared/language.ts';
import { acceptLanguage, languageSnapshot, subscribeLanguage, t } from './localeStore.ts';
export { t } from './localeStore.ts';
function accept(next: LanguageState) {
  document.documentElement.lang = next.locale;
  acceptLanguage(next);
}
export async function initializeLanguage(): Promise<void> {
  let observed = false;
  window.catsBot.language.onChange((next) => {
    observed = true;
    accept(next);
  });
  const initial = await window.catsBot.language.get();
  if (!observed) accept(initial);
}
export async function setLanguage(value: LanguagePreference): Promise<void> {
  accept(await window.catsBot.language.set(value));
}
export function useI18n() {
  const language = useSyncExternalStore(subscribeLanguage, languageSnapshot);
  return { ...language, t, setLanguage };
}
