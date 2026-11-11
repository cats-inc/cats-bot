import { useRef, useState, type FormEvent } from 'react';
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
      <div className="form">
        <h3>{t('Reset Cats Bot data')}</h3>
        <p>{t('Erase all active and archived cat bots, conversations, memories, schedules, stored secrets and Hub settings. Cats Bot restarts and returns to setup. Erased data cannot be recovered.')}</p>
        <p className="hint">{t('Runtime data is kept by default. Installed tools, provider logins, native CLI conversations outside Runtime storage, external workspaces and Cats Desktop data are kept.')}</p>
        <div className="row"><button type="button" className="danger" id="data-reset-open" onClick={open}>{t('Reset data…')}</button></div>
      </div>
      <dialog ref={dialog} className="data-reset-dialog" aria-labelledby="data-reset-title" onCancel={event => { if (busy) event.preventDefault(); }}>
        <form className="form" onSubmit={event => void reset(event)}>
          <h2 id="data-reset-title">{t('Reset Cats Bot data?')}</h2>
          <p>{t('All cat bots and Hub settings will be permanently erased. Running bots will stop before Cats Bot restarts.')}</p>
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
