import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderSetupState, SetupStepId } from '../../shared/providerSetup.ts';
import { errorText } from '../errors.ts';
import { useI18n } from '../i18n.ts';

export function ProviderInstallation({
  provider,
  onState,
  onBusy,
}: {
  provider: string;
  onState?(state: ProviderSetupState | null): void;
  onBusy?(busy: boolean): void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<ProviderSetupState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const callbacks = useRef({ onState, onBusy });
  callbacks.current = { onState, onBusy };
  const run = useCallback(
    async (step?: SetupStepId) => {
      if (!provider) return;
      const ticket = ++generation.current;
      setBusy(true);
      callbacks.current.onBusy?.(true);
      setError('');
      callbacks.current.onState?.(null);
      try {
        const next = step
          ? await window.catsBot.setup.install(provider, step)
          : await window.catsBot.setup.check(provider);
        if (generation.current !== ticket) return;
        setState(next);
        callbacks.current.onState?.(next);
      } catch (failure) {
        if (generation.current === ticket) setError(errorText(failure));
      } finally {
        if (generation.current === ticket) {
          setBusy(false);
          callbacks.current.onBusy?.(false);
        }
      }
    },
    [provider],
  );
  useEffect(() => {
    setState(null);
    void run();
    return () => {
      generation.current++;
    };
  }, [run]);
  const current = state?.provider === provider ? state : null;
  return (
    <section className="provider-installation" aria-busy={busy}>
      <h3>{t('Provider installation')}</h3>
      {busy && <p role="status">{t('Checking or installing the selected provider…')}</p>}
      {current?.steps.map((step) => (
        <div className="setup-step" key={step.id}>
          <div>
            <strong>{t(step.label)}</strong>
            <p>
              {t(step.status)}
              {step.version ? ` · ${step.version}` : ''}
            </p>
          </div>
          {step.status !== 'ready' && step.status !== 'auth_required' && (
            <button
              type="button"
              disabled={busy || step.status === 'prerequisite_required'}
              onClick={() => void run(step.id)}
            >
              {t(
                step.id === 'npm'
                  ? 'Prepare npm'
                  : step.id === 'shell'
                    ? 'Allow PowerShell scripts'
                    : 'Install {name}',
                { name: t(step.label) },
              )}
            </button>
          )}
          {step.id === 'shell' && step.status !== 'ready' && (
            <p className="hint">
              {t(
                'Lets PowerShell run codex and npm, so you can sign in there: your own execution policy becomes RemoteSigned.',
              )}
            </p>
          )}
          {step.status === 'auth_required' && (
            <p>{t('Installed. Complete the provider sign-in in a terminal, then check again.')}</p>
          )}
          {[...step.manualSteps, ...step.warnings].map((line, index) => (
            <p className="hint" key={index}>
              {t(line)}
            </p>
          ))}
        </div>
      ))}
      {error && (
        <p className="error" role="alert">
          {t(error)}
        </p>
      )}
      <button type="button" disabled={busy || !provider} onClick={() => void run()}>
        {t('Check again')}
      </button>
    </section>
  );
}
