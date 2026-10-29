import { t, useI18n } from '../i18n.ts';
import { useEffect, useState, type FormEvent } from 'react';

import type { ModelCatalog, ProviderInfo } from '../../core/types.ts';
import catUrl from '../cat.svg';
import { errorText } from '../errors.ts';
import { ModelField, useModelMenu } from './ModelField.tsx';
import { preferredProvider, providerChoices, providerHint, providerLabel } from './settingsLogic.ts';
import type { ProviderSetupState } from '../../shared/providerSetup.ts';
import { ProviderInstallation } from './ProviderInstallation.tsx';
import { LanguageField } from '../LanguageField.tsx';

/**
 * First run (SPEC-002 FR-1): no bot exists yet, so the page talks to the
 * shell's setup channel instead of the core. Closing it quits the app.
 */

const api = window.catsBot;
const fetchModels = (provider: string): Promise<ModelCatalog> => api.setup.models(provider);

export function SetupPage() {
  const { locale } = useI18n();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState('');
  const [name, setName] = useState('Mochi');
  const [instructions, setInstructions] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [setup, setSetup] = useState<ProviderSetupState | null>(null);
  const [installing, setInstalling] = useState(false);
  const { menu, setMenu, ready, model, selection } = useModelMenu(provider, null, fetchModels);
  const canStart = ready && setup?.provider === provider && setup.canFinish && !installing;

  useEffect(() => {
    void api.setup.providers().then((list) => {
      setProviders(list);
      setProvider(preferredProvider(list));
    });
  }, []);

  useEffect(() => {
    document.title = t('Set up Cats Bot');
  }, [locale]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canStart || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await api.setup.finish({
        name: name.trim(),
        provider,
        model,
        modelSelection: selection,
        instructions: instructions.trim(),
      });
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
        <h1>{t('Meet your bot')}</h1>
        <p className="lead">
          {t(
            'Choose your provider first. We will check its installation and help you install what it needs.',
          )}
        </p>
        <form id="setup-form" className="form" onSubmit={(event) => void submit(event)}>
          <LanguageField />
          <label className="field">
            <span>{t('Agent CLI')}</span>
            <select
              id="setup-provider"
              autoFocus
              disabled={installing || submitting}
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
            >
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
          <ProviderInstallation provider={provider} onState={setSetup} onBusy={setInstalling} />
          <label className="field">
            <span>{t('Name')}</span>
            <input
              id="setup-name"
              required
              maxLength={40}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <ModelField idPrefix="setup" menu={menu} onChange={setMenu} />
          <label className="field">
            <span>
              {t('Personality')}
              <em>{t('(optional)')}</em>
            </span>
            <textarea
              id="setup-instructions"
              rows={3}
              placeholder={t('You are a curious cat who keeps me company while I work.')}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </label>
          <p className="error" id="setup-error" hidden={!error}>
            {error}
          </p>
          <div className="actions">
            <button
              type="submit"
              className="primary"
              id="setup-submit"
              disabled={!canStart || submitting}
            >
              {submitting ? t('Starting…') : t('Create and start')}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
