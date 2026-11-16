import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Group, Row } from './Rows.tsx';
import { BOT_DATA_RESET_CONFIRMATION } from '../../shared/dataReset.ts';
import { t, useI18n } from '../i18n.ts';
import { errorText } from '../errors.ts';

export function DataTab() {
  useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirmation, setConfirmation] = useState('');
  const [resetRuntime, setResetRuntime] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  useEffect(() => { void window.catsBot.shell.state().then((state) => setRoot(state?.root ?? null)).catch(() => {}); }, []);
  const open = () => {
    setConfirmation('');
    setResetRuntime(false);
    setError(null);
    dialog.current?.showModal();
  };
  const reset = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || confirmation !== BOT_DATA_RESET_CONFIRMATION) return;
    setBusy(true);
    setError(null);
    try { await window.catsBot.shell.resetData({ confirmation, resetRuntime }); }
    catch (failure) { setError(t(errorText(failure))); setBusy(false); }
  };
  return (
    <section className="panel" data-panel="data">
      <h2>{t('Data')}</h2>
      <Group id="data-folder">
        <Row label={t('Data folder')} hint={root ?? '…'}>
          <button type="button" id="general-open-data" onClick={() => void window.catsBot.shell.openDataFolder()}>{t('Open')}</button>
        </Row>
      </Group>
      {/* ADR-031: what a reset erases and what it keeps, as two short lists. */}
      <section className="group" id="data-reset">
        <h3>{t('Reset Cats Bot data')}</h3>
        <div className="reset-lists">
          <div>
            <h4>{t('Erased')}</h4>
            <ul>
              <li>{t('Every cat bot, archived ones too, with the filespaces in their folders')}</li>
              <li>{t('Conversations, memories and schedules')}</li>
              <li>{t('Stored secrets, such as the Telegram token')}</li>
              <li>{t('Cats Bot Settings')}</li>
            </ul>
          </div>
          <div>
            <h4>{t('Kept')}</h4>
            <ul>
              <li>{t('Installed agent CLIs and their sign-ins')}</li>
              <li>{t('Runtime data, unless the reset erases it too')}</li>
              <li>{t('Conversations the CLIs keep themselves, and filespaces outside the cat bots’ folders')}</li>
              <li>{t('Cats Desktop data')}</li>
            </ul>
          </div>
        </div>
        <p className="hint">{t('Cats Bot then restarts and returns to setup. Erased data cannot be recovered.')}</p>
        <div className="row"><button type="button" className="danger" id="data-reset-open" onClick={open}>{t('Reset data…')}</button></div>
      </section>
      <dialog ref={dialog} className="data-reset-dialog" aria-labelledby="data-reset-title" onCancel={event => { if (busy) event.preventDefault(); }}>
        <form className="form" onSubmit={event => void reset(event)}>
          <h2 id="data-reset-title">{t('Reset Cats Bot data?')}</h2>
          <p>{t('All cat bots and Cats Bot Settings will be permanently erased. Running cat bots stop before Cats Bot restarts.')}</p>
          <label className="check">
            <input type="checkbox" id="data-reset-runtime" checked={resetRuntime} disabled={busy} onChange={event => setResetRuntime(event.target.checked)} />
            <span>{t('Also reset Runtime data')}</span>
          </label>
          <p className="hint">{t('Also erases every cat bot’s Runtime settings, provider selections, sessions, caches and Runtime-managed workspace files, including Runtime data retained by earlier resets. Installed tools and provider logins are kept.')}</p>
          <label className="field">
            <span>{t('Type RESET to confirm')}</span>
            <input id="data-reset-confirmation" value={confirmation} disabled={busy} autoComplete="off" spellCheck={false} onChange={event => setConfirmation(event.target.value)} />
          </label>
          {error && <p role="alert" className="error">{error}</p>}
          {busy && <p role="status">{t('Stopping cat bots and restarting…')}</p>}
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => dialog.current?.close()}>{t('Cancel')}</button>
            <button type="submit" className="danger armed" id="data-reset-confirm" disabled={busy || confirmation !== BOT_DATA_RESET_CONFIRMATION}>{t('Erase selected data')}</button>
          </div>
        </form>
      </dialog>
    </section>
  );
}
