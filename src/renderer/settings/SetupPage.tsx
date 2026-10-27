import { useEffect, useState, type FormEvent } from 'react';

import type { ModelCatalog, ProviderInfo } from '../../core/types.ts';
import catUrl from '../cat.svg';
import { errorText } from '../errors.ts';
import { ModelField, useModelMenu } from './ModelField.tsx';
import { preferredProvider, providerChoices, providerHint, providerLabel } from './settingsLogic.ts';

/**
 * First run (SPEC-002 FR-1): no bot exists yet, so the page talks to the
 * shell's setup channel instead of the core. Closing it quits the app.
 */

const api = window.catsBot;
const fetchModels = (provider: string): Promise<ModelCatalog> => api.setup.models(provider);

export function SetupPage() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState('');
  const [name, setName] = useState('Mochi');
  const [instructions, setInstructions] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { menu, setMenu, ready, model } = useModelMenu(provider, null, fetchModels);

  useEffect(() => {
    document.title = 'Set up Cats Bot';
    void api.setup.providers().then((list) => {
      setProviders(list);
      setProvider(preferredProvider(list));
    });
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await api.setup.finish({ name: name.trim(), provider, model, instructions: instructions.trim() });
    } catch (failure) {
      setError(errorText(failure));
      setSubmitting(false);
    }
  };

  const hint = providerHint(providers, provider);
  return (
    <section className="setup" id="setup">
      <div className="setup-card">
        <div className="setup-face" aria-hidden="true">
          <img src={catUrl} alt="" width="96" height="96" />
        </div>
        <h1>Meet your bot</h1>
        <p className="lead">
          It lives in your tray, keeps sticky notes on your desktop and checks in on its own. Pick the agent CLI it runs
          on; you can change everything later in Settings.
        </p>
        <form id="setup-form" className="form" onSubmit={(event) => void submit(event)}>
          <label className="field">
            <span>Name</span>
            <input id="setup-name" required maxLength={40} autoFocus value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="field">
            <span>Agent CLI</span>
            <select id="setup-provider" value={provider} onChange={(event) => setProvider(event.target.value)}>
              {providerChoices(providers, null).map((item) => (
                <option key={item.id} value={item.id}>
                  {providerLabel(item)}
                </option>
              ))}
            </select>
            <small className={hint.warn ? 'hint warn' : 'hint'} id="setup-provider-hint">
              {hint.text}
            </small>
          </label>
          <ModelField idPrefix="setup" menu={menu} onChange={setMenu} />
          <label className="field">
            <span>
              Personality <em>(optional)</em>
            </span>
            <textarea
              id="setup-instructions"
              rows={3}
              placeholder="You are a curious cat who keeps me company while I work."
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </label>
          <p className="error" id="setup-error" hidden={!error}>
            {error}
          </p>
          <div className="actions">
            <button type="submit" className="primary" id="setup-submit" disabled={!ready || submitting}>
              {submitting ? 'Starting…' : 'Create and start'}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
