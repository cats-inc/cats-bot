import { useEffect, useState } from 'react';

import type { HubReplyLanguage } from '../../shared/language.ts';
import { errorText } from '../errors.ts';
import { t, useI18n } from '../i18n.ts';
import { hubReplyLanguageOptions } from './settingsLogic.ts';
import { useToast } from './toast.ts';

/**
 * SPEC-008 FR-28: the reply language Cats Bot Settings sets for every bot. A
 * bot can choose its own on its Bot tab.
 */
export function ReplyLanguageField() {
  const { locale } = useI18n();
  const toast = useToast();
  const [value, setValue] = useState<HubReplyLanguage | null>(null);

  useEffect(() => {
    void window.catsBot.replyLanguage.get().then(setValue);
  }, []);

  const change = async (next: HubReplyLanguage) => {
    const previous = value;
    setValue(next);
    try {
      setValue(await window.catsBot.replyLanguage.set(next));
    } catch (failure) {
      setValue(previous);
      toast(t('Could not change the reply language: {value0}', { value0: errorText(failure) }));
    }
  };

  return (
    <label className="field">
      <span>{t('Reply language')}</span>
      <select
        id="reply-language"
        value={value ?? ''}
        disabled={value === null}
        onChange={(event) => void change(event.target.value as HubReplyLanguage)}
      >
        {hubReplyLanguageOptions(locale).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <small className="hint">
        {t('Bots reply in this language unless you ask for another one in the conversation. A bot can choose its own in its settings.')}
      </small>
    </label>
  );
}
