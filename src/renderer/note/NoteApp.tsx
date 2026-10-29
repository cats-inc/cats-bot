import { t, useI18n } from '../i18n.ts';
import { conversationTitle } from '../localeStore.ts';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import type { ApprovalDecision, TranscriptEntry, WorkItem, BotInteraction } from '../../core/types.ts';
import { DesktopControlBar, DesktopGrantCard, useDesktopControl } from '../desktopControl/DesktopControl.tsx';
import { InteractionCard } from '../interactions/InteractionCard.tsx';
import type { NoteLayer } from '../bridge.ts';
import { Markdown } from '../markdown/Markdown.tsx';
import {
  addEntry,
  appendDelta,
  buildNoteItems,
  entryClass,
  entryMeta,
  entryText,
  errorText,
  liveInteractions,
  localEntry,
  toolSummary,
  upsertWorkItem,
  visibleEntries,
  type DecisionItem,
  type DecisionStatus,
  type PendingReply,
  type ToolItem,
} from './transcript.ts';

/**
 * The sticky note (SPEC-001 FR-33, SPEC-003). It holds no durable state: the
 * transcript is read from the core, streamed text is shown live, and
 * everything else is a command through the preload bridge.
 */

const LAYER_ICONS: Record<NoteLayer, string> = { normal: '▢', top: '📌', desktop: '🖥', wallpaper: '🖼' };
const LAYER_TITLES: Record<NoteLayer, string> = {
  normal: 'Normal window',
  top: 'Always on top',
  desktop: 'On the desktop, below windows',
  wallpaper: 'On the wallpaper, below icons',
};

const api = window.catsBot;

function Entry({ entry }: { entry: TranscriptEntry }) {
  useI18n();
  const meta = entryMeta(entry);
  return (
    <div className={entryClass(entry.kind)}>
      {entry.kind === 'bot' ? <Markdown text={entry.text} /> : entryText(entry)}
      {meta && <span className="entry-meta">{meta}</span>}
    </div>
  );
}

const TOOL_STATUS: Record<ToolItem['status'], { mark: string; label: string }> = {
  running: { mark: '…', label: 'running' },
  done: { mark: '✓', label: 'done' },
  error: { mark: '✕', label: 'failed' },
};

/** SPEC-003 FR-4: a tool call and its result, collapsed to one line until opened. */
function ToolCard({ item }: { item: ToolItem }) {
  useI18n();
  const [open, setOpen] = useState(false);
  const status = TOOL_STATUS[item.status];
  return (
    <div className={`tool-card tool-${item.status}`}>
      <button
        className="tool-head"
        aria-expanded={open}
        title={open ? t('Hide details') : t('Show input and result')}
        onClick={() => setOpen(!open)}
      >
        <span className="tool-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="tool-name" title={item.name}>
          {item.name}
        </span>
        <span className="tool-summary">{toolSummary(item)}</span>
        <span className="tool-status" title={t(status.label)}>
          {status.mark}
        </span>
      </button>
      {open && (
        <div className="tool-body">
          {item.input && (
            <>
              <div className="tool-label">{t('Input')}</div>
              <pre className="tool-text">{item.input}</pre>
            </>
          )}
          <div className="tool-label">{t('Result')}</div>
          {item.result === null ? (
            <div className="tool-empty">
              {item.status === 'running' ? t('Still running…') : t('No result was reported.')}
            </div>
          ) : (
            <pre className="tool-text">{item.result || t('(empty)')}</pre>
          )}
        </div>
      )}
    </div>
  );
}

const DECISION_OUTCOMES: Record<Exclude<DecisionStatus, 'waiting'>, string> = {
  approved: 'Approved',
  denied: 'Denied',
  expired: 'Expired',
};

/** SPEC-003 FR-5: a question for the owner; buttons only while its work item waits. */
function DecisionCard({ item }: { item: DecisionItem }) {
  useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (decision: ApprovalDecision) => {
    setBusy(true);
    setError(null);
    try {
      await api.invoke('resolveApproval', item.workItemId, decision);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`entry entry-decision decision-${item.status}`}>
      <div className="decision-text">{item.entry.text}</div>
      {item.status === 'waiting' ? (
        <div className="decision-actions">
          <button
            className="decision-approve"
            disabled={busy}
            onClick={() => void decide('approve')}
          >
            {t('Approve')}
          </button>
          <button className="decision-deny" disabled={busy} onClick={() => void decide('deny')}>
            {t('Deny')}
          </button>
        </div>
      ) : (
        <div className="decision-outcome">
          {t(DECISION_OUTCOMES[item.status])}
          {item.detail ? `: ${item.detail}` : ''}
        </div>
      )}
      {error && <div className="decision-error">{error}</div>}
    </div>
  );
}

export function NoteApp() {
  const { locale } = useI18n();
  const requested = api.conversationId;
  // The note may be opened as `home`; the record's id replaces it once known.
  const conversation = useRef(requested);
  const runningRef = useRef(false);
  const transcriptRef = useRef<HTMLElement>(null);
  const interactionAnchor = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const [title, setTitle] = useState('Cats Bot');
  const [unread, setUnread] = useState(0);
  const [layer, setLayer] = useState<NoteLayer>('normal');
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [pending, setPending] = useState<PendingReply | null>(null);
  const [running, setRunningState] = useState(false);
  const [runtimeNote, setRuntimeNote] = useState('');
  const [draft, setDraft] = useState('');
  const [interactions, setInteractions] = useState<BotInteraction[]>([]);
  const desktop = useDesktopControl(conversation);
  const refreshDesktop = desktop.refresh;
  const refreshInteractions = useCallback(async () => {
    const snapshot = await api.invoke('providerInteractions', conversation.current);
    setInteractions(snapshot.interactions);
    const status = await api.invoke('status');
    setRunningState(status.queue.running?.conversationId === conversation.current);
    runningRef.current = status.queue.running?.conversationId === conversation.current;
  }, []);

  const setRunning = useCallback((value: boolean) => {
    runningRef.current = value;
    setRunningState(value);
  }, []);

  const refreshHeader = useCallback(async () => {
    const conversations = await api.invoke('listConversations');
    const record = conversations.find((item) => item.id === conversation.current)
      ?? (requested === 'home' ? conversations.find((item) => item.role === 'home') : undefined);
    if (!record) return;
    conversation.current = record.id;
    const profile = await api.invoke('getProfile');
    setTitle(`${profile.name} · ${conversationTitle(record)}`);
    setUnread(record.unreadCount);
    setLayer((await api.window.state()).layer);
  }, [requested, locale]);

  // A transcript read keeps the reply being streamed; it is not in the transcript until the turn ends.
  const reload = useCallback(async () => {
    const id = conversation.current;
    const [transcript, work] = await Promise.all([api.invoke('transcript', id), api.invoke('listWorkItems')]);
    setEntries(visibleEntries(transcript));
    setWorkItems(work.filter((item) => item.conversationId === id));
  }, []);

  // Only a note the owner is looking at reads its replies (a background desktop note does not).
  const markSeenIfFocused = useCallback(async () => {
    if (document.hasFocus()) await api.invoke('markSeen', conversation.current);
  }, []);

  useEffect(() => {
    const offEvent = api.onEvent((event) => {
      const id = conversation.current;
      switch (event.type) {
        case 'provider.interactions':
          if (event.conversationId === id) void refreshInteractions();
          return;
        case 'desktop.control':
          if (event.conversationId === null || event.conversationId === id) void refreshDesktop();
          return;
        case 'turn.delta':
          if (event.conversationId !== id) return;
          if (event.entry.kind === 'bot') setPending((current) => appendDelta(current, event.workItemId, event.entry.text));
          else setEntries((current) => addEntry(current, event.entry));
          return;
        case 'work.updated':
        case 'work.awaitingOwner':
          if (event.workItem.conversationId !== id) return;
          setWorkItems((current) => upsertWorkItem(current, event.workItem));
          if (event.type === 'work.updated' && event.workItem.state === 'running') {
            setRunning(true);
            // The desktop control status follows the turn (SPEC-133 DC-18 `active_turn`).
            void refreshDesktop();
          }
          return;
        case 'turn.completed':
          if (event.conversationId !== id) return;
          setRunning(false);
          void refreshDesktop();
          void reload()
            .then(() => setPending(null))
            .then(markSeenIfFocused)
            .then(refreshHeader);
          return;
        case 'conversation.updated':
          if (event.conversation.id !== id) return;
          void refreshHeader();
          void reload();
          void refreshDesktop();
          return;
        case 'runtime.status':
          setRuntimeNote(event.state === 'ready' ? '' : `runtime ${event.state}`);
          return;
        default:
          return;
      }
    });
    const offLayer = api.window.onLayer(setLayer);
    // A desktop note is lifted into an ordinary window when it is used; give the typing back to the input.
    const offLifted = api.window.onLifted(() => {
      if (!document.activeElement || document.activeElement === document.body) inputRef.current?.focus();
    });
    const onFocus = () => {
      void api.invoke('markSeen', conversation.current).then(refreshHeader);
      void refreshDesktop();
    };
    window.addEventListener('focus', onFocus);
    void refreshHeader().then(reload).then(refreshInteractions).then(markSeenIfFocused).then(refreshHeader);
    void refreshDesktop();
    const interactionPoll = setInterval(() => { void refreshInteractions().catch(() => {}); }, 3000);
    return () => {
      offEvent();
      offLayer();
      offLifted();
      window.removeEventListener('focus', onFocus);
      clearInterval(interactionPoll);
    };
  }, [markSeenIfFocused, refreshHeader, reload, setRunning, refreshInteractions, refreshDesktop]);

  const items = useMemo(() => buildNoteItems(entries, workItems), [entries, workItems]);
  const activeRequests = liveInteractions(interactions);
  const grantRequests = desktop.state?.conversation?.pendingRequests ?? [];
  const activeRequestIds = [...activeRequests.map(i => i.interactionId), ...grantRequests.map(r => r.requestId)].join(',');

  useLayoutEffect(() => {
    if (activeRequestIds) return;
    const element = transcriptRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [items, pending, activeRequestIds]);
  useLayoutEffect(() => {
    if (activeRequestIds) interactionAnchor.current?.scrollIntoView({ block: 'start' });
  }, [activeRequestIds]);

  const send = async () => {
    const text = draft.trim();
    if (!text || runningRef.current) return;
    setDraft('');
    setRunning(true);
    try {
      await api.invoke('sendOwnerMessage', conversation.current, text);
    } catch (error) {
      setRunning(false);
      setEntries((current) => [
        ...current,
        localEntry('error', t('Could not send: {error}', { error: errorText(error) })),
      ]);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter that confirms an IME candidate (Chinese, Japanese, …) is not a send.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <>
      <header className="note-header" id="header">
        <span className="note-title" id="title">
          {title}
        </span>
        <span className="note-unread" id="unread" hidden={unread === 0}>
          {unread}
        </span>
        <span className="note-state" id="state">
          {interactions.some((i) => i.status === 'pending') || grantRequests.length > 0
            ? t('waiting for you')
            : running
              ? t('thinking…')
              : t(runtimeNote)}
        </span>
        <span className="note-spacer" />
        <button
          className="note-button"
          id="settings"
          title={t('Settings and conversations')}
          onClick={() => void api.shell.openSettings()}
        >
          ⚙
        </button>
        <button
          className="note-button"
          id="layer"
          title={`${t(LAYER_TITLES[layer])} (${t('click to change')})`}
          onClick={() => void api.window.layerMenu()}
        >
          {LAYER_ICONS[layer]}
        </button>
        <button
          className="note-button"
          id="hide"
          title={t('Hide (the bot keeps running)')}
          onClick={() => void api.window.hide()}
        >
          ✕
        </button>
      </header>
      <DesktopControlBar model={desktop} />
      <main className="note-transcript" id="transcript" ref={transcriptRef} aria-live="polite">
        {items.map((item) => {
          if (item.type === 'tool') return <ToolCard key={item.key} item={item} />;
          if (item.type === 'decision') return <DecisionCard key={item.key} item={item} />;
          return <Entry key={item.key} entry={item.entry} />;
        })}
        {pending && (
          <div className="entry entry-bot pending">
            <Markdown text={pending.text} />
          </div>
        )}
        <div ref={interactionAnchor}>
          {activeRequests.map((i) => (
            <InteractionCard
              key={`${i.workerGeneration}:${i.interactionId}`}
              interaction={i}
              refresh={refreshInteractions}
            />
          ))}
          {grantRequests.map((r) => (
            <DesktopGrantCard key={r.requestId} request={r} model={desktop} />
          ))}
        </div>
      </main>
      <footer className="note-composer">
        <textarea
          id="input"
          ref={inputRef}
          rows={2}
          placeholder={t('Say something… (Enter to send, Shift+Enter for a new line)')}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="note-actions">
          <button className="note-send" id="send" disabled={running} onClick={() => void send()}>
            {t('Send')}
          </button>
          <button
            className="note-cancel"
            id="cancel"
            hidden={!running}
            onClick={() => void api.invoke('cancelTurn', conversation.current)}
          >
            {t('Cancel')}
          </button>
        </div>
      </footer>
    </>
  );
}
