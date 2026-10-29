import { LANGUAGE_OPTIONS, type LanguagePreference } from '../shared/language.ts';
import { useI18n } from './i18n.ts';

export function LanguageField() {
  const { preference, setLanguage, t } = useI18n();
  return (
    <label className="field">
      <span>{t('Display language')}</span>
      <select
        id="display-language"
        value={preference}
        onChange={(event) => void setLanguage(event.target.value as LanguagePreference)}
      >
        {LANGUAGE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {t(option.label)}
          </option>
        ))}
      </select>
    </label>
  );
}
