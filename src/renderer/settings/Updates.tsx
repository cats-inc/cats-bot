import { useEffect, useState } from 'react';
import type { BotUpdateAction, BotUpdateState } from '../../shared/shellUpdate.ts';
import { errorText } from '../errors.ts';

export function Updates() {
  const [state, setState] = useState<BotUpdateState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  useEffect(() => {
    let active = true, observed = false;
    const off = window.catsBot.shell.onUpdate(next => { observed = true; if (active) setState(next); });
    void window.catsBot.shell.updateState().then(next => { if (active && !observed) setState(next); }).catch(failure => { if (active) setError(errorText(failure)); });
    return () => { active = false; off(); };
  }, []);
  const action = async (command: BotUpdateAction) => {
    setActing(true); setError(null);
    try { setState(await window.catsBot.shell.updateAction(command)); }
    catch (failure) { setError(errorText(failure)); }
    finally { setActing(false); }
  };
  const busy = acting || Boolean(state && ['checking', 'downloading', 'installing'].includes(state.phase));
  const messages = {
    idle: 'Check for a newer version of Cats Bot.', checking: 'Checking for updates…', current: 'You are up to date.',
    available: 'A new version is available.', downloading: 'Downloading update…', downloaded: 'The update is ready to install.',
    installing: 'Stopping the bot and opening the installer…', error: 'The update could not be completed.', unavailable: 'Updates are unavailable for this build.',
  };
  return <section className="update-panel" aria-label="App updates">
    <h3>Updates</h3>
    {state && <>
      <p>Version {state.currentVersion}{state.distribution === 'standard-preview' ? ' · Standard Preview' : ''}</p>
      <p role="status">{messages[state.phase]}{state.version ? ` Version ${state.version}.` : ''}</p>
      {state.phase === 'downloading' && <progress max={100} value={state.percent ?? 0} aria-label="Download progress" />}
      {state.reason && <p className="hint">{state.reason}</p>}
      <div className="row">
        <button type="button" disabled={busy || !state.canCheck || state.phase === 'downloaded'} onClick={() => void action('check')}>Check for Updates</button>
        {state.phase === 'available' && state.canInstall && <button type="button" className="primary" disabled={busy} onClick={() => void action('download')}>Download update</button>}
        {state.phase === 'downloaded' && state.canInstall && <button type="button" className="primary" disabled={busy} onClick={() => void action('install')}>Restart and install</button>}
        {state.version && <button type="button" disabled={busy} onClick={() => void action('release')}>Open release page</button>}
      </div>
    </>}
    {(error || state?.error) && <p role="alert">{error ?? state?.error}</p>}
  </section>;
}
