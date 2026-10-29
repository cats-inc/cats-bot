import { t, useI18n } from '../i18n.ts';
import { useCallback, useEffect, useState } from 'react';

import type { BotProfile, DesktopControlState } from '../../core/types.ts';
import { enabledNotesText, settingsRow } from '../desktopControl/desktopControl.ts';
import { useToast } from './toast.ts';

/**
 * SPEC-006 BDC-02: the profile switch for desktop control, off by default. It saves at once
 * through `updateProfile`; turning it off revokes every grant and ends the helper. Hidden off
 * Windows, where there is nothing to set.
 */

const api = window.catsBot;

export function DesktopControlSettings({ onSaved }: { onSaved(profile: BotProfile): void }) {
  useI18n();
  const toast = useToast();
  const [state, setState] = useState<DesktopControlState | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await api.invoke('desktopControlState'));
    } catch {
      setState(null);
    }
  }, []);
  useEffect(() => {
    void load();
    // A note's switch, a stop or the helper's availability may change while the page is open.
    return api.onEvent((event) => {
      if (event.type === 'desktop.control') void load();
    });
  }, [load]);

  const save = async (enabled: boolean) => {
    setSaving(true);
    try {
      onSaved(await api.invoke('updateProfile', { desktopControl: { enabled } }));
      toast(
        enabled
          ? t('Desktop control on; turn it on in each conversation that should use it')
          : t('Desktop control off; every app grant is revoked'),
      );
    } catch {
      toast(t('Could not save the desktop control setting'));
    } finally {
      setSaving(false);
      await load();
    }
  };

  const row = settingsRow(state);
  if (row.hidden) return null;
  return (
    <section className="provider-settings" id="desktop-control-settings">
      <h3>{t('Desktop control')}</h3>
      <p className="hint">
        {t(
          'Lets the bot see the Windows apps you grant, only in conversations where you turn it on and only in messages you send from this computer (the conversation or cats-bot say). Each tool call asks for your approval, so choose "Choose access and approval separately" above with "Ask when requested by the agent" or "Ask for untrusted commands". The bot never sees other windows.',
        )}
      </p>
      <label className="check">
        <input
          type="checkbox"
          id="desktop-control-enabled"
          checked={state?.enabled === true}
          disabled={saving || row.disabled}
          onChange={(event) => void save(event.target.checked)}
        />
        <span>{t('Allow desktop control')}</span>
      </label>
      {row.note && (
        <p className="hint warn" id="desktop-control-note">
          {row.note}
        </p>
      )}
      {state?.enabled && !row.note && (
        <p className="hint" id="desktop-control-notes">
          {enabledNotesText(state)}
        </p>
      )}
      <p className="hint">
        {t(
          'Off by default. Turning it off revokes every app grant. Stop it at any time from the tray or the conversation.',
        )}
      </p>
    </section>
  );
}
