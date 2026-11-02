import { t, useI18n } from '../i18n.ts';

import { BOT_AVATARS, BOT_AVATAR_LABELS, type BotAvatar } from '../../shared/avatars.ts';
import { avatarUrl } from '../avatarArt.ts';

/**
 * SPEC-008 FR-29: which look a bot's Cat has, on the first-run and New bot page
 * and on the Bot tab. Several bots may share one, so nothing here is ever taken.
 */
export function AvatarField({
  idPrefix,
  value,
  disabled = false,
  onChange,
}: {
  idPrefix: string;
  value: BotAvatar;
  disabled?: boolean;
  onChange(avatar: BotAvatar): void;
}) {
  useI18n();
  return (
    <fieldset className="avatar-field" id={`${idPrefix}-avatar`} disabled={disabled}>
      <legend>{t('Appearance')}</legend>
      <div className="avatar-choices">
        {BOT_AVATARS.map((avatar) => (
          <label key={avatar} className="avatar-choice">
            <input
              type="radio"
              name={`${idPrefix}-avatar`}
              value={avatar}
              checked={value === avatar}
              onChange={() => onChange(avatar)}
            />
            <img src={avatarUrl(avatar)} alt="" width="56" height="56" />
            <span>{t(BOT_AVATAR_LABELS[avatar])}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
