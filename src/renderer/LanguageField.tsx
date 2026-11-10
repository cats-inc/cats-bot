import { LANGUAGE_OPTIONS, type LanguagePreference } from '../shared/language.ts';
import { useI18n } from './i18n.ts';
import { Row } from './settings/Rows.tsx';

export function LanguageField() {
  const { preference, setLanguage, t } = useI18n();
  return (
    <Row label={t('Display language')} htmlFor="display-language">
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
    </Row>
  );
}
