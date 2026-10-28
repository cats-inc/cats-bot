import { useEffect, useState, type FormEvent } from 'react';

import type { BotProfile, ModelCatalog, ProviderInfo } from '../../core/types.ts';
import { errorText } from '../errors.ts';
import { ModelField, useModelMenu } from './ModelField.tsx';
import { botForm, botPatch, providerChoices, providerHint, providerLabel, saveNotice, type BotForm } from './settingsLogic.ts';
import { useToast } from './toast.ts';
import { ProviderSettings } from './ProviderSettings.tsx';

/**
 * SPEC-002 FR-2–FR-3: name, agent CLI, model, personality and permissions.
 * Every change goes through `updateProfile`; only what changed is sent.
 */

const api = window.catsBot;
const fetchModels = (provider: string): Promise<ModelCatalog> => api.invoke('listModels', provider);

export function BotTab({ profile, onSaved }: { profile: BotProfile; onSaved(profile: BotProfile): void }) {
  const toast = useToast();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [form, setForm] = useState<BotForm>(() => botForm(profile));
  const [notice, setNotice] = useState('');
  // Coming back to the saved provider shows its saved model again, so saving keeps it.
  const preselect = form.provider === profile.executionTarget.provider ? profile.executionTarget.model : null;
  const { menu, setMenu, ready, model } = useModelMenu(form.provider, preselect, fetchModels);

  useEffect(() => {
    void api.invoke('listProviders').then(setProviders);
  }, []);

  const update = (patch: Partial<BotForm>) => setForm((current) => ({ ...current, ...patch }));

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    const patch = botPatch(profile, { ...form, model });
    if (!patch) {
      toast('Nothing changed');
      return;
    }
    try {
      const saved = await api.invoke('updateProfile', patch);
      setNotice(saveNotice(profile, saved, patch));
      onSaved(saved);
      toast('Saved');
    } catch (failure) {
      toast(`Could not save: ${errorText(failure)}`);
    }
  };

  const browse = async () => {
    const chosen = await api.shell.chooseFolder(form.cwd);
    if (chosen) update({ cwd: chosen });
  };

  const hint = providerHint(providers, form.provider);
  return (
    <section className="panel" data-panel="bot">
      <h2>Bot</h2>
      <form id="bot-form" className="form" onSubmit={(event) => void save(event)}>
        <label className="field">
          <span>Name</span>
          <input id="bot-name" required maxLength={40} value={form.name} onChange={(event) => update({ name: event.target.value })} />
        </label>
        <label className="field">
          <span>Agent CLI</span>
          <select id="bot-provider" value={form.provider} onChange={(event) => update({ provider: event.target.value })}>
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
        <ModelField idPrefix="bot" menu={menu} onChange={setMenu} showSource />
        <label className="field">
          <span>Personality and instructions</span>
          <textarea
            id="bot-instructions"
            rows={5}
            placeholder="Who the bot is and how it should talk to you."
            value={form.instructions}
            onChange={(event) => update({ instructions: event.target.value })}
          />
        </label>
        <details className="advanced">
          <summary>Workspace and permissions</summary>
          <label className="field">
            <span>Workspace folder</span>
            <div className="row">
              <input id="bot-cwd" value={form.cwd} onChange={(event) => update({ cwd: event.target.value })} />
              <button type="button" id="bot-cwd-browse" onClick={() => void browse()}>
                Browse…
              </button>
            </div>
          </label>
          <label className="field">
            <span>File access</span>
            <select
              id="bot-access"
              value={form.workspaceAccess}
              onChange={(event) => update({ workspaceAccess: event.target.value as BotForm['workspaceAccess'] })}
            >
              <option value="read_write">Read and write</option>
              <option value="read_only">Read only</option>
            </select>
          </label>
          <label className="field">
            <span>Tool permissions</span>
            <select
              id="bot-permission"
              disabled={profile.providerPolicy !== null}
              value={form.permissionMode}
              onChange={(event) => update({ permissionMode: event.target.value as BotForm['permissionMode'] })}
            >
              <option value="default">The CLI's own default</option>
              <option value="whitelist">Only the allowed tools below</option>
              <option value="skip">Allow every tool without asking</option>
            </select>
          </label>
          {profile.providerPolicy && <p className="hint">Legacy tool permissions are inactive. Change approval and access in Provider access and tools below. File access above remains a host limit.</p>}
          <label className="field" id="bot-tools-field" hidden={form.permissionMode !== 'whitelist'}>
            <span>
              Allowed tools <em>(comma separated)</em>
            </span>
            <input
              id="bot-tools"
              disabled={profile.providerPolicy !== null}
              placeholder="Read, Grep, WebSearch"
              value={form.allowedTools}
              onChange={(event) => update({ allowedTools: event.target.value })}
            />
          </label>
        </details>
        <p className="notice" id="bot-notice" hidden={!notice}>
          {notice}
        </p>
        <div className="actions">
          <button type="submit" className="primary" id="bot-save" disabled={!ready}>
            Save
          </button>
        </div>
      </form>
      <ProviderSettings profile={profile} onSaved={onSaved} />
    </section>
  );
}
