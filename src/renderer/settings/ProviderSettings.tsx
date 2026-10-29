import { t, useI18n } from '../i18n.ts';
import { conversationTitle } from '../localeStore.ts';
import { useEffect, useRef, useState } from 'react';
import type { BotProfile, ConversationRecord, ExecutionAccess, ExecutionApproval, SessionCapabilitiesSnapshot, SessionExecutionPolicy } from '../../core/types.ts';

const api = window.catsBot;
export function ProviderSettings({
  profile,
  onSaved,
}: {
  profile: BotProfile;
  onSaved(profile: BotProfile): void
}) {
  useI18n();
  const saved = profile.providerPolicy;
  const [mode, setMode] = useState<'legacy' | 'provider' | 'explicit'>(saved?.mode ?? 'legacy');
  const [access, setAccess] = useState<ExecutionAccess>(
    saved?.mode === 'explicit' ? saved.access : (saved?.constraints.maxAccess ?? 'workspace-write'),
  );
  const [network, setNetwork] = useState(
    saved?.mode === 'explicit' ? saved.network : (saved?.constraints.network ?? false),
  );
  const [approval, setApproval] = useState<ExecutionApproval>(saved?.mode === 'explicit' ? saved.approval : 'on-request');
  const [notes, setNotes] = useState<ConversationRecord[]>([]);
  const [conversation, setConversation] = useState('');
  const [snapshot, setSnapshot] = useState<SessionCapabilitiesSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const inspection = useRef(0);
  useEffect(() => () => { inspection.current += 1; }, []);
  useEffect(() => { void api.invoke('listConversations').then(list => { setNotes(list); setConversation(list.find(n => n.role === 'home')?.id ?? ''); }); }, []);
  const inspect = async (refresh: boolean) => {
    if (!conversation) return;
    const ticket = ++inspection.current;
    setBusy(true);
    setNotice('');
    try {
      const result = await api.invoke('sessionCapabilities', conversation, refresh);
      if (inspection.current === ticket) setSnapshot(result);
    } catch {
      if (inspection.current === ticket) {
        setSnapshot(null);
        setNotice(t('Session observation is unavailable.'));
      }
    } finally {
      if (inspection.current === ticket) setBusy(false);
    }
  };
  useEffect(() => { setSnapshot(null); void inspect(false); }, [conversation]);
  const save = async () => {
    setBusy(true);
    setNotice('');
    const policy: SessionExecutionPolicy | null = mode === 'legacy' ? null : mode === 'provider'
      ? { version: 1, mode, constraints: { maxAccess: access, network } }
      : { version: 1, mode, access, network: access === 'full-access' ? true : access === 'read-only' ? false : network, approval };
    try {
      const next = await api.invoke('updateProfile', { providerPolicy: policy });
      onSaved(next);
      setNotice(
        t('Saved. The current turn keeps its admitted policy; new sessions use this selection.'),
      );
    } catch {
      setNotice(
        t(
          'Could not apply this policy. Check the workspace boundary and clear any legacy tool allowlist first.',
        ),
      );
    } finally {
      setBusy(false);
    }
  };
  const observation = snapshot?.observation;
  return (
    <section className="provider-settings">
      <h3>{t('Provider access and tools')}</h3>
      <label className="field">
        <span>{t('Execution policy')}</span>
        <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="legacy">{t('Keep existing tool permission settings')}</option>
          <option value="provider">{t('Use provider configuration within a limit')}</option>
          <option value="explicit">{t('Choose access and approval separately')}</option>
        </select>
      </label>
      {mode !== 'legacy' && (
        <>
          <label className="field">
            <span>
              {mode === 'provider' ? t('Maximum admitted access') : t('Local file access')}
            </span>
            <select value={access} onChange={(e) => setAccess(e.target.value as ExecutionAccess)}>
              <option value="read-only">{t('Read only')}</option>
              <option value="workspace-write">{t('Write in the workspace')}</option>
              <option value="full-access">{t('Full machine access')}</option>
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              disabled={mode === 'explicit' && access !== 'workspace-write'}
              checked={
                mode === 'explicit' && access === 'full-access'
                  ? true
                  : mode === 'explicit' && access === 'read-only'
                    ? false
                    : network
              }
              onChange={(e) => setNetwork(e.target.checked)}
            />{' '}
            {mode === 'provider' ? t('Allow provider network access') : t('Network access')}
          </label>
          {mode === 'explicit' && (
            <label className="field">
              <span>{t('Approval policy')}</span>
              <select
                value={approval}
                onChange={(e) => setApproval(e.target.value as ExecutionApproval)}
              >
                <option value="on-request">{t('Ask when requested by the agent')}</option>
                <option value="untrusted">{t('Ask for untrusted commands')}</option>
                <option value="never">{t('Never prompt; enforce the access limit')}</option>
              </select>
            </label>
          )}
          <p className="hint">
            {t(
              'The selected Runtime/provider must support this policy. A tool approval cannot bypass a limited workspace or network policy. Remote MCP servers may have their own access.',
            )}
          </p>
          {profile.executionTarget.provider === 'claude' && (
            <p className="hint warn">
              {t(
                'Claude Code cannot limit file or network access on Windows, so only full machine access with network can be saved. Choose "Ask when requested by the agent" to approve each action yourself.',
              )}
            </p>
          )}
        </>
      )}
      <button type="button" disabled={busy} onClick={() => void save()}>
        {t('Save provider policy')}
      </button>
      <h3>{t('Current session')}</h3>
      <label className="field">
        <span>{t('Conversation')}</span>
        <select value={conversation} onChange={(e) => setConversation(e.target.value)}>
          {notes.map((n) => (
            <option key={n.id} value={n.id}>
              {conversationTitle(n)}
            </option>
          ))}
        </select>
      </label>
      <button type="button" disabled={busy || !conversation} onClick={() => void inspect(true)}>
        {t('Refresh observation')}
      </button>
      {notice && <p role="status">{t(notice)}</p>}
      {snapshot && !snapshot.observation && (
        <p>
          {snapshot.reason?.replaceAll('_', ' ') ?? t('No live observation')}
          {t('. No model turn was started.')}
        </p>
      )}
      {observation && (
        <>
          <p>
            {t('Policy:')}
            {observation.policy.source} · {observation.policy.status}
            {observation.policy.reason
              ? ` · ${observation.policy.reason.replaceAll('_', ' ')}`
              : ''}
          </p>
          {observation.policy.observed && (
            <p>
              {t('Observed:')}
              {observation.policy.observed.access}
              {t('; network')}
              {observation.policy.observed.network ? t('allowed') : t('off')}
              {t('; approval')}
              {observation.policy.observed.approval}
              {t('; reviewer')}
              {observation.policy.observed.reviewer}.
            </p>
          )}
          <p>
            {t('Tools:')}
            {observation.inventory.state}
            {observation.inventory.stale ? t(' · stale') : ''} ·{' '}
            {observation.inventory.observedAt ?? t('not yet observed')}.
          </p>
          <p className="hint">
            {t(
              'This is the top-level MCP list. Nested tools may load later. Discovery does not verify a browser or desktop operation.',
            )}
          </p>
          {observation.inventory.servers.map((s) => (
            <details key={s.name}>
              <summary>
                {s.name} · {s.source} · {s.connection} · {s.tools.length}
                {t('tools')}
              </summary>
              <p>
                {t('Authentication mechanism:')}
                {s.auth}
                {t('. Discovery:')}
                {s.discovery}
                {t('. Invocation: not verified.')}
              </p>
              <ul>
                {s.tools.map((t) => (
                  <li key={t.qualifiedName}>{t.qualifiedName}</li>
                ))}
              </ul>
            </details>
          ))}
          {observation.inventory.builtinTools?.length ? (
            <details>
              <summary>
                {t('Built-in tools ·')}
                {observation.inventory.builtinTools.length}
              </summary>
              <ul>
                {observation.inventory.builtinTools.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </details>
          ) : null}
          {observation.inventory.dynamicTools.length > 0 && (
            <details>
              <summary>{t('Runtime dynamic tools')}</summary>
              <ul>
                {observation.inventory.dynamicTools.map((t) => (
                  <li key={t.name}>{t.name}</li>
                ))}
              </ul>
            </details>
          )}
          {observation.dependencies.map((d) => (
            <p key={d.kind}>
              {d.kind === 'browser' ? t('Browser') : t('Computer use')}: {d.status}. {d.evidence}{' '}
              {d.remediation}
            </p>
          ))}
        </>
      )}
    </section>
  );
}
