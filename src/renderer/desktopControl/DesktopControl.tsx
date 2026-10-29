import { t, useI18n } from '../i18n.ts';
import { useCallback, useRef, useState, type MutableRefObject } from 'react';

import type { DesktopControlState, DesktopGrantDecision, DesktopGrantRequest } from '../../core/types.ts';
import { grantCardText, grantedText, holdingBanner, notePanelVisible, noteStatus, showStop, switchDisabled } from './desktopControl.ts';

/**
 * SPEC-006 P3 and P5 in the note: the conversation switch, the DC-18 status, grant request
 * cards, Stop, and the banner while the bot holds control (BDC-10). Grants are answered only
 * through `respondDesktopGrant`, never the provider path.
 */

const api = window.catsBot;

export interface DesktopControlModel {
  state: DesktopControlState | null;
  busy: boolean;
  failed: boolean;
  refresh(): Promise<void>;
  setEnabled(enabled: boolean): void;
  answer(requestId: string, decision: DesktopGrantDecision): void;
  stop(): void;
}

/** The note's desktop control state; `conversation` is the note's conversation id once known. */
export function useDesktopControl(conversation: MutableRefObject<string>): DesktopControlModel {
  const [state, setState] = useState<DesktopControlState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // Only the newest read may land, so a slow answer cannot replace a newer one.
  const reads = useRef(0);

  const refresh = useCallback(async () => {
    const ticket = ++reads.current;
    try {
      const next = await api.invoke('desktopControlState', conversation.current);
      if (ticket === reads.current) setState(next);
    } catch {
      if (ticket === reads.current) setState(null);
    }
  }, [conversation]);

  const act = useCallback((action: () => Promise<DesktopControlState>) => {
    setBusy(true);
    setFailed(false);
    void (async () => {
      try {
        const next = await action();
        reads.current += 1;
        setState(next);
      } catch {
        setFailed(true);
        await refresh();
      } finally {
        setBusy(false);
      }
    })();
  }, [refresh]);

  return {
    state,
    busy,
    failed,
    refresh,
    setEnabled: (enabled) => act(() => api.invoke('setConversationDesktopControl', conversation.current, enabled)),
    answer: (requestId, decision) => act(() => api.invoke('respondDesktopGrant', conversation.current, requestId, decision)),
    stop: () => act(() => api.invoke('stopDesktopControl', conversation.current)),
  };
}

/** The strip under the note's header. */
export function DesktopControlBar({ model }: { model: DesktopControlModel }) {
  useI18n();
  const { state } = model;
  if (!notePanelVisible(state)) return null;
  const conversation = state.conversation;
  const status = noteStatus(state, conversation);
  const granted = grantedText(conversation);
  const holding = holdingBanner(conversation);
  return (
    <section className="desktop-bar" id="desktop-control" aria-label={t('Desktop control')}>
      <div className="desktop-row">
        <label
          className="desktop-switch"
          title={t('Let the bot see apps you grant, in messages you send from this computer')}
        >
          <input
            type="checkbox"
            id="desktop-enabled"
            checked={conversation.enabled}
            disabled={model.busy || switchDisabled(state, conversation)}
            onChange={(event) => model.setEnabled(event.target.checked)}
          />{' '}
          {t('Desktop control')}
        </label>
        <span className="note-spacer" />
        {showStop(conversation) && !holding && (
          <button
            className="desktop-stop"
            id="desktop-stop"
            disabled={model.busy}
            onClick={() => model.stop()}
          >
            {t('Stop')}
          </button>
        )}
      </div>
      {holding && (
        <div className="desktop-holding" id="desktop-holding" role="alert">
          <span>{holding}</span>
          <button
            className="desktop-stop"
            id="desktop-holding-stop"
            disabled={model.busy}
            onClick={() => model.stop()}
          >
            {t('Stop')}
          </button>
        </div>
      )}
      {status && !holding && (
        <div className="desktop-status" id="desktop-status" role="status">
          {status}
        </div>
      )}
      {granted && (
        <div className="desktop-granted" id="desktop-granted">
          {granted}
        </div>
      )}
      {model.failed && (
        <div className="desktop-error" role="alert">
          {t('Could not update desktop control. Try again.')}
        </div>
      )}
    </section>
  );
}

/** SPEC-133 DC-08: one app the bot asks to see; only the owner's Allow grants it. */
export function DesktopGrantCard({
  request,
  model,
}: {
  request: DesktopGrantRequest;
  model: DesktopControlModel
}) {
  useI18n();
  const text = grantCardText(request);
  return (
    <section className="provider-card desktop-grant" aria-label={t('Desktop control request')}>
      <strong>{text.title}</strong>
      <small className="desktop-path">{text.path}</small>
      <small>{text.publisher}</small>
      {text.observeOnly && <small>{text.observeOnly}</small>}
      <p>{text.reason}</p>
      <small>
        {t('Expires')}
        {new Date(request.expiresAt).toLocaleTimeString()}
        {t('. Only you can answer, here or with cats-bot desktop.')}
      </small>
      <div className="provider-actions">
        <button
          type="button"
          className="decision-approve"
          disabled={model.busy}
          onClick={() => model.answer(request.requestId, 'allow')}
        >
          {t('Allow')}
        </button>
        <button
          type="button"
          className="decision-deny"
          disabled={model.busy}
          onClick={() => model.answer(request.requestId, 'deny')}
        >
          {t('Deny')}
        </button>
      </div>
    </section>
  );
}
