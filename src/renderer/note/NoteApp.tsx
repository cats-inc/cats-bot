import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

import type { TranscriptEntry } from '../../core/types.ts';
import type { NoteLayer } from '../bridge.ts';
import { Markdown } from '../markdown/Markdown.tsx';
import {
  addEntry,
  appendDelta,
  entryClass,
  entryKey,
  entryMeta,
  entryText,
  errorText,
  localEntry,
  visibleEntries,
  type PendingReply,
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
  const meta = entryMeta(entry);
  return (
    <div className={entryClass(entry.kind)}>
      {entry.kind === 'bot' ? <Markdown text={entry.text} /> : entryText(entry)}
      {meta && <span className="entry-meta">{meta}</span>}
    </div>
  );
}

export function NoteApp() {
  const requested = api.conversationId;
  // The note may be opened as `home`; the record's id replaces it once known.
  const conversation = useRef(requested);
  const runningRef = useRef(false);
  const transcriptRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const [title, setTitle] = useState('Cats Bot');
  const [unread, setUnread] = useState(0);
  const [layer, setLayer] = useState<NoteLayer>('normal');
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [pending, setPending] = useState<PendingReply | null>(null);
  const [running, setRunningState] = useState(false);
  const [runtimeNote, setRuntimeNote] = useState('');
  const [draft, setDraft] = useState('');

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
    setTitle(record.role === 'home' ? profile.name : `${profile.name} · ${record.title}`);
    setUnread(record.unreadCount);
    setLayer((await api.window.state()).layer);
  }, [requested]);

  // A transcript read keeps the reply being streamed; it is not in the transcript until the turn ends.
  const reload = useCallback(async () => {
    setEntries(visibleEntries(await api.invoke('transcript', conversation.current)));
  }, []);

  // Only a note the owner is looking at reads its replies (a background desktop note does not).
  const markSeenIfFocused = useCallback(async () => {
    if (document.hasFocus()) await api.invoke('markSeen', conversation.current);
  }, []);

  useEffect(() => {
    const offEvent = api.onEvent((event) => {
      const id = conversation.current;
      switch (event.type) {
        case 'turn.delta':
          if (event.conversationId !== id) return;
          if (event.entry.kind === 'bot') setPending((current) => appendDelta(current, event.workItemId, event.entry.text));
          else setEntries((current) => addEntry(current, event.entry));
          return;
        case 'work.updated':
          if (event.workItem.conversationId === id && event.workItem.state === 'running') setRunning(true);
          return;
        case 'turn.completed':
          if (event.conversationId !== id) return;
          setRunning(false);
          void reload()
            .then(() => setPending(null))
            .then(markSeenIfFocused)
            .then(refreshHeader);
          return;
        case 'conversation.updated':
          if (event.conversation.id !== id) return;
          void refreshHeader();
          void reload();
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
    };
    window.addEventListener('focus', onFocus);
    void refreshHeader().then(reload).then(markSeenIfFocused).then(refreshHeader);
    return () => {
      offEvent();
      offLayer();
      offLifted();
      window.removeEventListener('focus', onFocus);
    };
  }, [markSeenIfFocused, refreshHeader, reload, setRunning]);

  useLayoutEffect(() => {
    const element = transcriptRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [entries, pending]);

  const send = async () => {
    const text = draft.trim();
    if (!text || runningRef.current) return;
    setDraft('');
    setRunning(true);
    try {
      await api.invoke('sendOwnerMessage', conversation.current, text);
    } catch (error) {
      setRunning(false);
      setEntries((current) => [...current, localEntry('error', `Could not send: ${errorText(error)}`)]);
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
        <span className="note-title" id="title">{title}</span>
        <span className="note-unread" id="unread" hidden={unread === 0}>
          {unread}
        </span>
        <span className="note-state" id="state">{running ? 'thinking…' : runtimeNote}</span>
        <span className="note-spacer" />
        <button className="note-button" id="settings" title="Settings and notes" onClick={() => void api.shell.openSettings()}>
          ⚙
        </button>
        <button className="note-button" id="layer" title={`${LAYER_TITLES[layer]} (click to change)`} onClick={() => void api.window.layerMenu()}>
          {LAYER_ICONS[layer]}
        </button>
        <button className="note-button" id="hide" title="Hide (the bot keeps running)" onClick={() => void api.window.hide()}>
          ✕
        </button>
      </header>
      <main className="note-transcript" id="transcript" ref={transcriptRef} aria-live="polite">
        {entries.map((entry) => (
          <Entry key={entryKey(entry)} entry={entry} />
        ))}
        {pending && (
          <div className="entry entry-bot pending">
            <Markdown text={pending.text} />
          </div>
        )}
      </main>
      <footer className="note-composer">
        <textarea
          id="input"
          ref={inputRef}
          rows={2}
          placeholder="Say something… (Enter to send, Shift+Enter for a new line)"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="note-actions">
          <button className="note-send" id="send" disabled={running} onClick={() => void send()}>
            Send
          </button>
          <button className="note-cancel" id="cancel" hidden={!running} onClick={() => void api.invoke('cancelTurn', conversation.current)}>
            Cancel
          </button>
        </div>
      </footer>
    </>
  );
}
