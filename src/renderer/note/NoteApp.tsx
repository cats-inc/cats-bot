import { ConversationMessage, ConversationResponse, ConversationMarkdown, RetryActionIcon } from '@cats-inc/platform-ui-web';
import '@cats-inc/platform-ui-web/conversation.css';
import { t, useI18n } from '../i18n.ts';
import { conversationWorkState } from './workState.ts';
import { avatarUrl } from '../avatarArt.ts';
import { conversationTitle } from '../localeStore.ts';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import type { ApprovalDecision, TranscriptEntry, WorkItem, BotInteraction } from '../../core/types.ts';
import { DesktopControlBar, DesktopGrantCard, useDesktopControl } from '../desktopControl/DesktopControl.tsx';
import { InteractionCard } from '../interactions/InteractionCard.tsx';
import type { NoteLayer } from '../bridge.ts';
import { screenshotOutcome } from './screenshot.ts';
import { MAX_ATTACHMENT_BYTES, attachedFilesMessage, extractAttachments, type MessageAttachment } from '../../shared/attachments.ts';
import { voicePrivacyMessage } from '../../shared/voice.ts';
import type { SystemSettingsPane } from '../../shared/systemSettings.ts';
import { useDictation } from './dictation.ts';
import { ComposerGlyph } from './composerIcons.tsx';
import { executionSummary } from './executionSummary.ts';
import { foldedStepCount, isLiveReply, stepsLinkLabel } from './responseSteps.ts';
import {
  clearComposerNotice,
  raiseComposerNotice,
  type ComposerNotice,
  type ComposerNoticeSource,
} from './composerNotice.ts';
import { LAYER_PLATES, layerPlateStates } from './layerPlates.ts';
import {
  addEntry,
  appendDelta,
  buildNoteItems,
  retryableOwnerEntry,
  entryMeta,
  entryText,
  errorText,
  liveInteractions,
  mergeTranscriptEntries,
  upsertWorkItem,
  mergeWorkItems,
  noteRoleSuffix,
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

const LAYER_TITLES: Record<NoteLayer, string> = {
  normal: 'Normal window',
  top: 'Always on top',
  desktop: 'On the desktop, below windows',
  wallpaper: 'On the wallpaper, below icons',
};

function LayerIcon({ layer }: { layer: NoteLayer }) {
  const states = layerPlateStates(layer);
  return (
    <svg className="note-layer-icon" viewBox="0 0 24 24" aria-hidden="true">
      {LAYER_PLATES.map((plate, index) => <path key={plate.layer} d={plate.path} className={states[index]} />)}
    </svg>
  );
}

/**
 * The header's other two glyphs, drawn like the layer plates (24 unit grid shown at 18 px, 1.5 stroke) so the
 * three buttons read as one set; a text "⚙" and "✕" sized with the font did not.
 */
function SettingsGlyph() {
  return (
    <svg className="note-header-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10.31 5.21L10.59 3.11A9 9 0 0 1 13.41 3.11L13.69 5.21A7 7 0 0 1 15.61 6L17.29 4.72A9 9 0 0 1 19.28 6.71L18 8.39A7 7 0 0 1 18.79 10.31L20.89 10.59A9 9 0 0 1 20.89 13.41L18.79 13.69A7 7 0 0 1 18 15.61L19.28 17.29A9 9 0 0 1 17.29 19.28L15.61 18A7 7 0 0 1 13.69 18.79L13.41 20.89A9 9 0 0 1 10.59 20.89L10.31 18.79A7 7 0 0 1 8.39 18L6.71 19.28A9 9 0 0 1 4.72 17.29L6 15.61A7 7 0 0 1 5.21 13.69L3.11 13.41A9 9 0 0 1 3.11 10.59L5.21 10.31A7 7 0 0 1 6 8.39L4.72 6.71A9 9 0 0 1 6.71 4.72L8.39 6A7 7 0 0 1 10.31 5.21Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function HideGlyph() {
  return (
    <svg className="note-header-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </svg>
  );
}

const api = window.catsBot;

const FileIcon = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </svg>
);

/** SPEC-003 FR-8: an attached image, read back from the bot's working directory. */
function AttachedImage({ conversationId, attachment }: { conversationId: string; attachment: MessageAttachment }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api.invoke('attachmentPreview', conversationId, attachment.relativePath).then((image) => {
      if (live && image) setSrc(`data:${image.mimeType};base64,${image.data}`);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [conversationId, attachment.relativePath]);
  return src
    ? <img className="messageBodyImage" src={src} alt={attachment.filename} />
    : <span className="messageBodyFileChip"><FileIcon size={14} />{attachment.filename}</span>;
}

function OwnerBody({ conversationId, entry }: { conversationId: string; entry: TranscriptEntry }) {
  const { attachments, text } = extractAttachments(entry.text);
  const images = attachments.filter((attachment) => attachment.isImage);
  const files = attachments.filter((attachment) => !attachment.isImage);
  return <div className="messageBodyWrapper">
    {images.length > 0 && <div className="messageBodyImages">
      {images.map((attachment) => <AttachedImage key={attachment.relativePath} conversationId={conversationId} attachment={attachment} />)}
    </div>}
    {files.length > 0 && <div className="messageBodyFiles">
      {files.map((attachment) => <span key={attachment.relativePath} className="messageBodyFileChip"><FileIcon size={14} />{attachment.filename}</span>)}
    </div>}
    {text && <p className="messageBody">{text}</p>}
  </div>;
}

/** A failed owner message: the note shows it failed and offers to run its turn again. */
interface EntryRetry {
  onRetry: () => void;
}

function Entry({ entry, conversationId, retry }: {
  entry: TranscriptEntry;
  conversationId: string;
  retry?: EntryRetry;
}) {
  useI18n();
  const meta = entryMeta(entry);
  const copyText = entry.kind === 'owner' ? extractAttachments(entry.text).text : entry.text;
  const actions = retry
    ? [{ key: `retry:${entry.seq}`, title: t('Retry response'), icon: <RetryActionIcon />, onSelect: retry.onRetry }]
    : undefined;
  return <ConversationMessage senderKind={entry.kind === 'owner' ? 'user' : entry.kind === 'bot' ? 'agent' : 'system'}
    copyLabel={t('Copy')} showCopy={!!copyText.trim()}
    onCopy={() => { void navigator.clipboard.writeText(copyText); }} actions={actions}>
    {entry.kind === 'bot' ? <div className="messageBodyWrapper"><ConversationMarkdown text={entry.text} /></div>
      : entry.kind === 'owner' ? <OwnerBody conversationId={conversationId} entry={entry} />
        : <p className="messageBody">{entryText(entry)}</p>}
    {meta && <span className="entry-meta">{meta}</span>}
    {retry && <div className="userTurnStatus userTurnStatusFailed">{t('Response failed')}</div>}
  </ConversationMessage>;
}

/**
 * The glyph of the composer button a notice is about, struck out, so the notice reads as that button's.
 * Send is a text button: its notice has an alert mark instead.
 */
function NoticeSourceIcon({ source }: { source: ComposerNoticeSource }) {
  if (source === 'send') {
    return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.75v3.75" />
      <path d="M8 11.1v.15" />
    </svg>;
  }
  return <ComposerGlyph kind={source} size={14} struck />;
}

/**
 * ADR-024: a failed composer action (dictation, screenshot, attachment, send) is one notice at the top of the
 * composer. It stays until the owner closes it, the action works again or another failure replaces it.
 */
function ComposerNoticeBar({ notice, onDismiss }: { notice: ComposerNotice; onDismiss: () => void }) {
  useI18n();
  const pane = notice.pane;
  return <div className="composerNotice" role="status" data-source={notice.source}>
    <span className="composerNoticeIcon"><NoticeSourceIcon source={notice.source} /></span>
    <span className="composerNoticeText">
      {notice.message}
      {pane && <button type="button" className="composerNoticeAction"
        onClick={() => { void api.systemSettings?.open(pane).catch(() => undefined); }}>
        {t('Open System Settings')}
      </button>}
    </span>
    <button type="button" className="composerNoticeDismiss" aria-label={t('Dismiss')} title={t('Dismiss')}
      onClick={onDismiss}>
      <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
        <path d="M2 2l6 6M8 2l-6 6" />
      </svg>
    </button>
  </div>;
}

/** SPEC-003 FR-8: a file waiting to go with the next message, as Cats Desktop shows it in its composer. */
function AttachmentCard({ file, disabled, onRemove }: { file: File; disabled: boolean; onRemove: () => void }) {
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith('image/')) return;
    // The note's policy allows data: images, not blob: ones.
    const reader = new FileReader();
    reader.onload = () => { if (typeof reader.result === 'string') setPreview(reader.result); };
    reader.readAsDataURL(file);
    return () => reader.abort();
  }, [file]);
  return <div className="attachmentCard">
    <button className="attachmentRemove" type="button" disabled={disabled} onClick={onRemove}
      aria-label={t('Remove {fileName}', { fileName: file.name })}
      title={t('Remove {fileName}', { fileName: file.name })}>&times;</button>
    {preview ? <img className="attachmentPreview" src={preview} alt={file.name} />
      : <div className="attachmentFileIcon"><FileIcon size={24} /></div>}
    <span className="attachmentName">{file.name}</span>
  </div>;
}

async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

function ToolCard({ item }: { item: ToolItem }) {
  useI18n();
  return <ConversationResponse response={{ version: 1, id: item.key, phase: item.status === 'running' ? 'streaming' : 'sealed',
    blocks: [{ id: item.key, index: 0, kind: 'tool', status: item.status === 'running' ? 'streaming' : item.status === 'error' ? 'error' : 'complete',
      title: null, text: item.result ?? item.input, toolId: null, toolName: item.name, input: item.input, result: item.result }] }}
    labels={{ tool: t('Tool'), input: t('Input'), result: t('Result'), noResult: t('No result was reported.'), error: t('Incomplete or failed') }}
    copyLabel={t('Copy')} showProgressDetails />;
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
  const structuredWork = useRef(new Set<string>());
  const transcriptRef = useRef<HTMLElement>(null);
  const interactionAnchor = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const [title, setTitle] = useState('Cats Bot');
  // The direct message's send button is a paper plane; every other note's is an up arrow.
  const [directMessage, setDirectMessage] = useState(requested === 'home');
  // The header's (i): the bot's provider, model and reasoning effort, read from its model catalog.
  const [executionInfo, setExecutionInfo] = useState('');
  const executionRequest = useRef(0);

  // Undefined until the header is read: nothing is sent before the window knows what note this is.
  // A header that cannot be read leaves the window usable; the core refuses contact-note writes anyway.
  const [contact, setContact] = useState<{ bot: string; other: string } | null | undefined>(undefined);
  const [speakerName, setSpeakerName] = useState('Cats Bot');
  // SPEC-008 FR-29: replies carry the bot's look; nothing until its profile is read.
  const [speakerAvatar, setSpeakerAvatar] = useState<string | undefined>(undefined);
  // SPEC-003 FR-12: the bot's live progress details switch, and the finished replies whose steps are open.
  const [progressDetails, setProgressDetails] = useState(false);
  const [openSteps, setOpenSteps] = useState<ReadonlySet<string>>(() => new Set());
  const toggleSteps = useCallback((id: string) => setOpenSteps((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  }), []);
  const followTranscript = useRef(true);
  const [unread, setUnread] = useState(0);
  const [layer, setLayer] = useState<NoteLayer>('normal');
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  // ADR-024: a failed composer action is one notice in the composer, never a transcript line.
  const [notice, setNotice] = useState<ComposerNotice | null>(null);
  const composerError = useCallback((source: ComposerNoticeSource, text: string, pane?: SystemSettingsPane | null) => {
    // ADR-020: the pane only where the shell can open it (macOS).
    setNotice(raiseComposerNotice(source, text, pane && api.systemSettings ? pane : null));
  }, []);
  const dismissNotice = useCallback(() => setNotice(null), []);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [pending, setPending] = useState<PendingReply | null>(null);
  const [running, setRunningState] = useState(false);
  const [runtimeNote, setRuntimeNote] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [draft, setDraft] = useState('');
  // SPEC-003 FR-8: files for the next message.
  const [files, setFiles] = useState<File[]>([]);
  const [capturing, setCapturing] = useState(false);
  // ADR-024: removing the file that was too large answers its notice.
  useEffect(() => {
    if (!files.some((file) => file.size > MAX_ATTACHMENT_BYTES)) setNotice((current) => clearComposerNotice(current, 'attach'));
  }, [files]);
  // SPEC-003 FR-9: the note steps aside while the owner drags out a region; the picture waits like a picked file.
  const takeScreenshot = async () => {
    if (capturing) return;
    setCapturing(true);
    try {
      const outcome = screenshotOutcome(await api.window.captureScreenshot());
      if (outcome.kind === 'file') {
        setFiles((current) => [...current, outcome.file]);
        setNotice((current) => clearComposerNotice(current, 'screenshot'));
      } else if (outcome.kind === 'error') composerError('screenshot', t(outcome.message), outcome.systemSettingsPane);
    } catch (error) {
      composerError('screenshot', t('Could not take a screenshot: {error}', { error: errorText(error) }));
    } finally {
      setCapturing(false);
    }
  };
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [interactions, setInteractions] = useState<BotInteraction[]>([]);
  const desktop = useDesktopControl(conversation);
  const refreshDesktop = desktop.refresh;
  const refreshInteractions = useCallback(async () => {
    const id = conversation.current;
    const [snapshot, status, work] = await Promise.all([
      api.invoke('providerInteractions', id), api.invoke('status'), api.invoke('listWorkItems', id),
    ]);
    setInteractions(snapshot.interactions);
    setWorkItems(current => mergeWorkItems(current, work.filter(item => item.conversationId === id)));
    setRunningState(status.queue.running?.conversationId === conversation.current);
    runningRef.current = status.queue.running?.conversationId === conversation.current;
  }, []);

  const setRunning = useCallback((value: boolean) => {
    runningRef.current = value;
    setRunningState(value);
  }, []);

  const refreshHeader = useCallback(async () => {
    const conversations = await api.invoke('listConversations').catch((error: unknown) => {
      // The core still refuses a write into a contact note; the window does not lock up.
      setContact((current) => current ?? null);
      throw error;
    });
    const record = conversations.find((item) => item.id === conversation.current)
      ?? (requested === 'home' ? conversations.find((item) => item.role === 'home') : undefined);
    if (!record) {
      setContact((current) => current ?? null);
      return;
    }
    conversation.current = record.id;
    setDirectMessage(record.role === 'home');
    const [profile, status] = await Promise.all([api.invoke('getProfile'), api.invoke('status')]);
    setProgressDetails(profile.showProgressDetails);
    // SPEC-012 FR-6: the owner reads a contact note but never writes in it.
    setContact(record.contactOf ? { bot: profile.name, other: record.contactName ?? record.contactOf } : null);
    setSpeakerName(profile.name);
    setSpeakerAvatar(avatarUrl(profile.avatar));
    // SPEC-009 FR-10: the role belongs to the bot, so it follows the name, before the conversation.
    setTitle(`${profile.name}${noteRoleSuffix(status.bossCat)} · ${conversationTitle(record)}`);
    const request = ++executionRequest.current;
    const target = profile.executionTarget;
    void Promise.all([
      api.invoke('listModels', target.provider).catch(() => null),
      api.invoke('listProviders').catch(() => []),
    ]).then(([catalog, providers]) => {
      if (request !== executionRequest.current) return;
      setExecutionInfo(executionSummary(target, catalog, providers.find((item) => item.id === target.provider)?.label ?? null));
    });
    // SPEC-008 FR-17: the window's title carries the bot's name too.
    document.title = `${profile.name} · ${conversationTitle(record)}`;
    setUnread(record.unreadCount);
    setLayer((await api.window.state()).layer);
  }, [requested, locale]);

  // A transcript read keeps the reply being streamed; it is not in the transcript until the turn ends.
  const reload = useCallback(async () => {
    const id = conversation.current;
    try {
      const [transcript, work] = await Promise.all([api.invoke('conversationTranscript', id), api.invoke('listWorkItems', id)]);
      for (const entry of transcript) if (entry.presentation && entry.workItemId) structuredWork.current.add(entry.workItemId);
      setEntries(current => mergeTranscriptEntries(current, visibleEntries(transcript)));
      setWorkItems(current => mergeWorkItems(current, work.filter((item) => item.conversationId === id)));
      setHistoryError('');
    } catch (error) {
      setHistoryError(errorText(error));
    }
  }, []);

  // Only a note the owner is looking at reads its replies (a background desktop note does not).
  const markSeenIfFocused = useCallback(async () => {
    if (document.hasFocus()) await api.invoke('markSeen', conversation.current);
  }, []);

  useEffect(() => {
    const offEvent = api.onEvent((event) => {
      const id = conversation.current;
      switch (event.type) {
        case 'turn.presentation':
          if (event.conversationId !== id) return;
          structuredWork.current.add(event.workItemId);
          setPending(null);
          setEntries(current => addEntry(current, event.entry));
          return;
        case 'provider.interactions':
          if (event.conversationId === id) void refreshInteractions();
          return;
        case 'desktop.control':
          if (event.conversationId === null || event.conversationId === id) void refreshDesktop();
          return;
        case 'turn.delta':
          if (event.conversationId !== id) return;
          if (event.entry.presentation) setEntries(current => addEntry(current, event.entry));
          else if (event.entry.kind === 'bot') {
            if (!structuredWork.current.has(event.workItemId)) setPending((current) => appendDelta(current, event.workItemId, event.entry.text));
          }
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
        case 'profile.updated':
          void refreshHeader();
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
  const activity = conversationWorkState(workItems, conversation.current);
  const busy = running || activity.active;
  const activeRequests = liveInteractions(interactions);
  const grantRequests = desktop.state?.conversation?.pendingRequests ?? [];
  const activeRequestIds = [...activeRequests.map(i => i.interactionId), ...grantRequests.map(r => r.requestId)].join(',');

  useLayoutEffect(() => {
    if (activeRequestIds) return;
    const element = transcriptRef.current;
    if (element && followTranscript.current) element.scrollTop = element.scrollHeight;
  }, [items, pending, activeRequestIds]);
  useLayoutEffect(() => {
    if (activeRequestIds) interactionAnchor.current?.scrollIntoView({ block: 'start' });
  }, [activeRequestIds]);

  const send = async () => {
    const text = draft.trim();
    if ((!text && files.length === 0) || runningRef.current || busy || contact !== null) return;
    const tooLarge = files.find((file) => file.size > MAX_ATTACHMENT_BYTES);
    if (tooLarge) {
      composerError('attach', t('{fileName} is larger than {limit} MB', { fileName: tooLarge.name, limit: String(MAX_ATTACHMENT_BYTES / (1024 * 1024)) }));
      return;
    }
    const sending = files;
    setDraft('');
    setFiles([]);
    followTranscript.current = true;
    setRunning(true);
    try {
      const paths: string[] = [];
      for (const file of sending) {
        const stored = await api.invoke('addOwnerAttachment', conversation.current, file.name, await base64Of(file));
        paths.push(stored.relativePath);
      }
      await api.invoke('sendOwnerMessage', conversation.current, attachedFilesMessage(text, paths));
      setNotice((current) => clearComposerNotice(current, 'send'));
    } catch (error) {
      setRunning(false);
      // Nothing was sent: the owner gets the draft and the files back, with the reason under them.
      setDraft((current) => current || text);
      setFiles((current) => (current.length ? current : sending));
      composerError('send', t('Could not send: {error}', { error: errorText(error) }));
    }
  };

  const retryable = retryableOwnerEntry(entries, workItems, busy);
  const retry = async (workItemId: string) => {
    if (runningRef.current || busy) return;
    followTranscript.current = true;
    setRunning(true);
    try {
      await api.invoke('retryOwnerMessage', conversation.current, workItemId);
      setNotice((current) => clearComposerNotice(current, 'send'));
    } catch (error) {
      setRunning(false);
      composerError('send', t('Could not retry: {error}', { error: errorText(error) }));
    }
  };

  // SPEC-003 FR-10: dictation into the composer.
  const dictation = useDictation({
    inputRef, draft, setDraft, disabled: busy,
    onError: (message, pane) => composerError('voice', t(message), pane),
  });
  const privacy = voicePrivacyMessage(dictation.privacyMode);
  // The helper listening means the microphone and permissions are there now.
  useEffect(() => {
    if (dictation.listening) setNotice((current) => clearComposerNotice(current, 'voice'));
  }, [dictation.listening]);

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
        {/* Not a button: it shows its text on hover and on focus, like Cats Desktop's model (i). */}
        {executionInfo && <span className="note-info" id="execution-info" role="img" tabIndex={0} title={executionInfo}
          aria-label={t('Provider and model: {summary}', { summary: executionInfo })}>i</span>}
        <span className="note-unread" id="unread" hidden={unread === 0}>
          {unread}
        </span>
        <span className="note-state" id="state">
          {interactions.some((i) => i.status === 'pending') || grantRequests.length > 0
            ? t('waiting for you')
            : activity.waiting
              ? t('Waiting for the current turn…')
              : busy
                ? t('thinking…')
                : t(runtimeNote)}
        </span>
        <span className="note-spacer" />
        <button
          className="note-button"
          id="settings"
          title={t('Settings and conversations')}
          aria-label={t('Settings and conversations')}
          onClick={() => void api.shell.openSettings()}
        >
          <SettingsGlyph />
        </button>
        <button
          className="note-button"
          id="layer"
          title={`${t(LAYER_TITLES[layer])} (${t('click to change')})`}
          aria-label={`${t(LAYER_TITLES[layer])} (${t('click to change')})`}
          onClick={() => void api.window.layerMenu()}
        >
          <LayerIcon layer={layer} />
        </button>
        <button
          className="note-button"
          id="hide"
          title={t('Hide (the cat bot keeps running)')}
          aria-label={t('Hide (the cat bot keeps running)')}
          onClick={() => void api.window.hide()}
        >
          <HideGlyph />
        </button>
      </header>
      {contact === null && <DesktopControlBar model={desktop} />}
      <main className="note-transcript catsConversation" id="transcript" ref={transcriptRef} aria-live="polite"
        onScroll={() => { const element = transcriptRef.current; if (element) followTranscript.current = element.scrollHeight - element.clientHeight - element.scrollTop < 40; }}>
        {historyError && <div role="alert" className="decision-error">{t('Conversation history could not be restored: {error}', { error: historyError })}</div>}
        {items.map((item) => {
          if (item.type === 'response' && item.entry.presentation) {
            const response = item.entry.presentation;
            // SPEC-003 FR-12: with the switch on, a live reply shows its steps and a finished one folds them
            // behind a link of its own; with it off, only text and failed steps show.
            const live = isLiveReply(response);
            const folded = foldedStepCount(response);
            const open = progressDetails && (live || openSteps.has(response.id));
            const meta = entryMeta(item.entry);
            const link = progressDetails && !live && folded > 0
              ? <button type="button" className="response-steps" aria-expanded={open} onClick={() => toggleSteps(response.id)}>
                {stepsLinkLabel(folded, open)}<span aria-hidden="true">{open ? ' ▾' : ' ▸'}</span>
              </button>
              : null;
            return <ConversationResponse key={item.key}
              response={response} speaker={<div className="transcriptMessageTop"><img className="transcriptAvatar" src={speakerAvatar} alt="" /><strong>{speakerName}</strong></div>}
              labels={{ tool: t('Tool'), input: t('Input'), result: t('Result'), noResult: t('No result was reported.'), error: t('Incomplete or failed') }}
              showProgressDetails={open} copyLabel={t('Copy')}
              afterBubble={<span className="entry-meta">{meta}{meta && link ? ' · ' : null}{link}</span>}
              onCopy={text => { void navigator.clipboard.writeText(text).catch(() => {}); }} />;
          }
          if (item.type === 'tool') return <ToolCard key={item.key} item={item} />;
          if (item.type === 'decision') return <DecisionCard key={item.key} item={item} />;
          const failed = retryable !== null && item.entry.seq === retryable.seq && item.entry.workItemId;
          return <Entry key={item.key} entry={item.entry} conversationId={conversation.current}
            retry={failed && contact === null ? { onRetry: () => void retry(failed) } : undefined} />;
        })}
        {pending && (
          <ConversationMessage senderKind="agent" copyLabel={t('Copy')}>
            <ConversationMarkdown text={pending.text} />
          </ConversationMessage>
        )}
        <div ref={interactionAnchor}>
          {activeRequests.map((i) => (
            <InteractionCard
              key={`${i.workerGeneration}:${i.interactionId}`}
              interaction={i}
              refresh={refreshInteractions}
              choicesOnly={Boolean(contact)}
            />
          ))}
          {grantRequests.map((r) => (
            <DesktopGrantCard key={r.requestId} request={r} model={desktop} />
          ))}
        </div>
      </main>
      {contact ? (
        <footer className="note-composer note-contact" id="contact-note">
          <p>
            {t('This is the contact note between {bot} and {other}. You can read it but not write in it. To talk to {bot}, use its direct message.', contact)}
          </p>
          <div className="note-actions">
            <button type="button" id="open-direct-message" onClick={() => void api.window.openConversation('home')}>
              {t('Open the direct message')}
            </button>
            <span className="note-spacer" />
            <button
              className="note-cancel"
              id="cancel"
              hidden={!busy}
              onClick={() => void api.invoke('cancelTurn', conversation.current)}
            >
              {t('Cancel')}
            </button>
          </div>
        </footer>
      ) : <footer className="note-composer">
        {/* ADR-024: on top, so neither the draft nor the buttons move when a notice comes or goes. */}
        {notice && <ComposerNoticeBar key={notice.id} notice={notice} onDismiss={dismissNotice} />}
        {files.length > 0 && <div className="composerAttachments">
          {files.map((file, index) => <AttachmentCard key={`${file.name}-${file.size}-${index}`} file={file} disabled={busy}
            onRemove={() => setFiles((current) => current.filter((_, i) => i !== index))} />)}
        </div>}
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
          <button className="composerIconButton" id="attach" type="button" aria-label={t('Add photos and files')}
            title={t('Add photos and files')} disabled={busy} onClick={() => fileInputRef.current?.click()}>
            <ComposerGlyph kind="attach" />
          </button>
          <button className="composerIconButton" id="take-screenshot" type="button" aria-label={t('Take screenshot')}
            title={t('Take screenshot')} disabled={busy || capturing} onClick={() => void takeScreenshot()}>
            <ComposerGlyph kind="screenshot" />
          </button>
          <span className="note-spacer" />
          {dictation.supported && <button
            className={`composerIconButton composerVoiceButton${dictation.listening ? ' composerVoiceButtonActive' : ''}`}
            id="dictate" type="button" aria-pressed={dictation.active} disabled={busy}
            aria-label={dictation.active ? `${t('Stop voice input')}${privacy ? ` (${t(privacy)})` : ''}` : t('Start voice input')}
            title={privacy ? t(privacy) : dictation.active ? t('Stop voice input') : t('Start voice input')}
            onClick={dictation.toggle}>
            <ComposerGlyph kind="voice" />
            {privacy && <span className="composerVoicePrivacyBadge" aria-hidden="true">!</span>}
          </button>}
          <button className="note-send" id="send" type="button" disabled={busy} onClick={() => void send()}
            aria-label={t('Send')} title={t('Send')}>
            <ComposerGlyph kind={directMessage ? 'sendDirect' : 'send'} />
          </button>
          <button
            className="note-cancel"
            id="cancel"
            hidden={!busy}
            onClick={() => void api.invoke('cancelTurn', conversation.current)}
          >
            {t('Cancel')}
          </button>
        </div>
        <input ref={fileInputRef} id="attach-files" type="file" multiple hidden disabled={busy}
          onChange={(event) => {
            const input = event.currentTarget;
            const selected = input.files ? Array.from(input.files) : [];
            if (selected.length > 0) setFiles((current) => [...current, ...selected]);
            input.value = '';
          }} />
      </footer>}
    </>
  );
}
