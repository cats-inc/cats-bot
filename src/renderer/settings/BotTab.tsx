import { t, useI18n } from '../i18n.ts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import type { BotProfile, ModelCatalog, ProviderInfo } from '../../core/types.ts';
import type { ProviderSetupState } from '../../shared/providerSetup.ts';
import { errorText } from '../errors.ts';
import { ModelField, useModelMenu } from './ModelField.tsx';
import {
  botForm,
  botPatch,
  botReplyLanguageOptions,
  providerChoices,
  providerHint,
  providerLabel,
  saveNotice,
  type BotForm,
} from './settingsLogic.ts';
import { useToast } from './toast.ts';
import { DesktopControlSettings } from './DesktopControlSettings.tsx';
import { ProviderSettings } from './ProviderSettings.tsx';
import { ProviderInstallation } from './ProviderInstallation.tsx';

/**
 * SPEC-002 FR-2–FR-3: name, agent CLI, model, personality and permissions.
 * Every change goes through `updateProfile`; only what changed is sent.
 */

const api = window.catsBot;
const fetchModels = (provider: string): Promise<ModelCatalog> => api.invoke('listModels', provider);

export function BotTab({
  profile,
  onSaved,
}: {
  profile: BotProfile;
  onSaved(profile: BotProfile): void
}) {
  const { locale } = useI18n();
  const toast = useToast();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [form, setForm] = useState<BotForm>(() => botForm(profile));
  const [notice, setNotice] = useState('');
  const [installing, setInstalling] = useState(false);
  // Coming back to the saved provider shows its saved model again, so saving keeps it.
  const preselect = form.provider === profile.executionTarget.provider ? profile.executionTarget.model : null;
  const { menu, setMenu, ready, model, selection } = useModelMenu(
    form.provider,
    preselect,
    fetchModels,
    form.provider === profile.executionTarget.provider
      ? profile.executionTarget.modelSelection
      : undefined,
    form.provider === profile.executionTarget.provider,
  );

  const keepTarget = form.provider === profile.executionTarget.provider && !menu.edited;

  useEffect(() => {
    void api.invoke('listProviders').then(setProviders);
  }, []);
  // A CLI the helper just found is on PATH now, so the provider's hint follows it.
  const onSetupState = useCallback((state: ProviderSetupState | null) => {
    if (state) void api.invoke('listProviders').then(setProviders);
  }, []);

  const update = (patch: Partial<BotForm>) => setForm((current) => ({ ...current, ...patch }));

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if ((!ready && !keepTarget) || installing) return;
    const patch = botPatch(profile, {
      ...form,
      model: keepTarget ? profile.executionTarget.model : model,
      modelSelection: keepTarget ? profile.executionTarget.modelSelection : selection,
    });
    if (!patch) {
      toast(t('Nothing changed'));
      return;
    }
    try {
      const saved = await api.invoke('updateProfile', patch);
      setNotice(saveNotice(profile, saved, patch));
      onSaved(saved);
      toast(t('Saved'));
    } catch (failure) {
      toast(t('Could not save: {value0}', { value0: errorText(failure) }));
    }
  };

  const browse = async () => {
    const chosen = await api.shell.chooseFolder(form.cwd);
    if (chosen) update({ cwd: chosen });
  };

  const hint = providerHint(providers, form.provider);
  return (
    <section className="panel" data-panel="bot">
      <h2>{t('Bot')}</h2>
      <form id="bot-form" className="form" onSubmit={(event) => void save(event)}>
        <label className="field">
          <span>{t('Name')}</span>
          <input
            id="bot-name"
            required
            maxLength={40}
            value={form.name}
            onChange={(event) => update({ name: event.target.value })}
          />
        </label>
        <label className="field">
          <span>{t('Agent CLI')}</span>
          <select
            id="bot-provider"
            disabled={installing}
            value={providers.some((item) => item.id === form.provider) ? form.provider : ''}
            onChange={(event) => update({ provider: event.target.value })}
          >
            {!providers.some((item) => item.id === form.provider) && (
              <option value="" disabled hidden>
                {t('Choose a provider')}
              </option>
            )}
            {providerChoices(providers, profile.executionTarget.provider).map((item) => (
              <option key={item.id} value={item.id}>
                {providerLabel(item)}
              </option>
            ))}
          </select>
          <small className={hint.warn ? 'hint warn' : 'hint'} id="bot-provider-hint">
            {hint.text}
          </small>
        </label>
        {!providers.some((item) => item.id === form.provider) && (
          <p className="hint">
            {t('Saved provider: {provider}. It is kept until you choose a supported provider.', {
              provider: form.provider,
            })}
          </p>
        )}
        {providers.some((item) => item.id === form.provider) && (
          <ProviderInstallation provider={form.provider} onState={onSetupState} onBusy={setInstalling} />
        )}
        {form.provider === 'claude' && (
          <label className="check">
            <input
              type="checkbox"
              id="bot-chrome"
              checked={form.claudeInChrome}
              onChange={(event) => update({ claudeInChrome: event.target.checked })}
            />{' '}
            {t('Claude in Chrome: let the bot use Chrome or Edge through the Claude extension')}
          </label>
        )}
        <ModelField idPrefix="bot" menu={menu} onChange={setMenu} showSource />
        <label className="field">
          <span>{t('Personality and instructions')}</span>
          <textarea
            id="bot-instructions"
            rows={5}
            placeholder={t('Who the bot is and how it should talk to you.')}
            value={form.instructions}
            onChange={(event) => update({ instructions: event.target.value })}
          />
        </label>
        <label className="field">
          <span>{t('Reply language')}</span>
          <select
            id="bot-reply-language"
            value={form.replyLanguage}
            onChange={(event) => update({ replyLanguage: event.target.value as BotForm['replyLanguage'] })}
          >
            {botReplyLanguageOptions(locale, profile.hubLanguage).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <details className="advanced">
          <summary>{t('Workspace and permissions')}</summary>
          <label className="field">
            <span>{t('Workspace folder')}</span>
            <div className="row">
              <input
                id="bot-cwd"
                value={form.cwd}
                onChange={(event) => update({ cwd: event.target.value })}
              />
              <button type="button" id="bot-cwd-browse" onClick={() => void browse()}>
                {t('Browse…')}
              </button>
            </div>
          </label>
          <label className="field">
            <span>{t('File access')}</span>
            <select
              id="bot-access"
              value={form.workspaceAccess}
              onChange={(event) =>
                update({ workspaceAccess: event.target.value as BotForm['workspaceAccess'] })
              }
            >
              <option value="read_write">{t('Read and write')}</option>
              <option value="read_only">{t('Read only')}</option>
            </select>
          </label>
          <label className="field">
            <span>{t('Tool permissions')}</span>
            <select
              id="bot-permission"
              disabled={profile.providerPolicy !== null}
              value={form.permissionMode}
              onChange={(event) =>
                update({ permissionMode: event.target.value as BotForm['permissionMode'] })
              }
            >
              <option value="default">{t("The CLI's own default")}</option>
              <option value="whitelist">{t('Only the allowed tools below')}</option>
              <option value="skip">{t('Allow every tool without asking')}</option>
            </select>
          </label>
          {profile.providerPolicy && (
            <p className="hint">
              {t(
                'Legacy tool permissions are inactive. Change approval and access in Provider access and tools below. File access above remains a host limit.',
              )}
            </p>
          )}
          <label
            className="field"
            id="bot-tools-field"
            hidden={form.permissionMode !== 'whitelist'}
          >
            <span>
              {t('Allowed tools')}
              <em>{t('(comma separated)')}</em>
            </span>
            <input
              id="bot-tools"
              disabled={profile.providerPolicy !== null}
              placeholder={t('Read, Grep, WebSearch')}
              value={form.allowedTools}
              onChange={(event) => update({ allowedTools: event.target.value })}
            />
          </label>
        </details>
        <p className="notice" id="bot-notice" hidden={!notice}>
          {notice}
        </p>
        <div className="actions">
          <button
            type="submit"
            className="primary"
            id="bot-save"
            disabled={(!ready && !keepTarget) || installing}
          >
            {t('Save')}
          </button>
        </div>
      </form>
      <ProviderSettings profile={profile} onSaved={onSaved} />
      <DesktopControlSettings onSaved={onSaved} />
    </section>
  );
}
