import { useEffect, useRef, useState } from 'react';

import type { ConversationRecord, SessionCapabilitiesSnapshot } from '../../core/types.ts';
import { t, useI18n } from '../i18n.ts';
import { conversationTitle } from '../localeStore.ts';

/**
 * SPEC-004: what Runtime reports a conversation's session really has: its policy and the tools
 * it can see. Looking starts no model turn. It is for finding out why something does not work,
 * so it sits folded on Details rather than among the settings (ADR-030).
 */

const api = window.catsBot;

export function SessionCheck() {
  useI18n();
  const [notes, setNotes] = useState<ConversationRecord[]>([]);
  const [conversation, setConversation] = useState('');
  const [snapshot, setSnapshot] = useState<SessionCapabilitiesSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [open, setOpen] = useState(false);
  const inspection = useRef(0);
  useEffect(() => () => { inspection.current += 1; }, []);
  useEffect(() => {
    if (!open) return;
    void api.invoke('listConversations').then((list) => {
      setNotes(list);
      setConversation((current) => current || (list.find((note) => note.role === 'home')?.id ?? ''));
    });
  }, [open]);
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
  useEffect(() => { setSnapshot(null); if (open) void inspect(false); }, [conversation, open]);
  const observation = snapshot?.observation;
  return (
    <details className="advanced session-check" id="session-check" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{t('Session check')}</summary>
      <label className="field">
        <span>{t('Conversation')}</span>
        <select value={conversation} onChange={(event) => setConversation(event.target.value)}>
          {notes.map((note) => <option key={note.id} value={note.id}>{conversationTitle(note)}</option>)}
        </select>
      </label>
      <div className="actions">
        <button type="button" disabled={busy || !conversation} onClick={() => void inspect(true)}>{t('Refresh observation')}</button>
      </div>
      {snapshot && !snapshot.observation && (
        <p>{snapshot.reason?.replaceAll('_', ' ') ?? t('No live observation')}{t('. No model turn was started.')}</p>
      )}
      {observation && (
        <>
          <p>
            {t('Policy:')}
            {observation.policy.source} · {observation.policy.status}
            {observation.policy.reason ? ` · ${observation.policy.reason.replaceAll('_', ' ')}` : ''}
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
            {observation.inventory.stale ? t(' · stale') : ''} · {observation.inventory.observedAt ?? t('not yet observed')}.
          </p>
          <p className="hint">{t('This is the top-level MCP list. Nested tools may load later. Discovery does not verify a browser or desktop operation.')}</p>
          {observation.inventory.servers.map((server) => (
            <details key={server.name}>
              <summary>{server.name} · {server.source} · {server.connection} · {server.tools.length}{t('tools')}</summary>
              <p>
                {t('Authentication mechanism:')}{server.auth}{t('. Discovery:')}{server.discovery}{t('. Invocation: not verified.')}
              </p>
              <ul>{server.tools.map((tool) => <li key={tool.qualifiedName}>{tool.qualifiedName}</li>)}</ul>
            </details>
          ))}
          {observation.inventory.builtinTools?.length ? (
            <details>
              <summary>{t('Built-in tools ·')}{observation.inventory.builtinTools.length}</summary>
              <ul>{observation.inventory.builtinTools.map((tool) => <li key={tool}>{tool}</li>)}</ul>
            </details>
          ) : null}
          {observation.inventory.dynamicTools.length > 0 && (
            <details>
              <summary>{t('Runtime dynamic tools')}</summary>
              <ul>{observation.inventory.dynamicTools.map((tool) => <li key={tool.name}>{tool.name}</li>)}</ul>
            </details>
          )}
          {observation.dependencies.map((dependency) => (
            <p key={dependency.kind}>
              {dependency.kind === 'browser' ? t('Browser') : t('Computer use')}: {dependency.status}. {dependency.evidence} {dependency.remediation}
            </p>
          ))}
        </>
      )}
      {notice && <p className="notice" role="status">{notice}</p>}
    </details>
  );
}
