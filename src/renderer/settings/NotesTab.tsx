import { t, useI18n } from '../i18n.ts';
import { conversationTitle } from '../localeStore.ts';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import type { ConversationRecord } from '../../core/types.ts';
import type { NoteLayer, NoteLayersView } from '../bridge.ts';
import { errorText } from '../errors.ts';
import { reachesTelegram } from '../note/speakers.ts';
import { layerStack, NOTE_LAYER_NAMES, noteMeta, removalCopy, sortNotes } from './settingsLogic.ts';
import { useToast } from './toast.ts';

/**
 * SPEC-002 FR-5, FR-5b, FR-8: every conversation with its unread count, session state and layer. Each row has
 * the same three controls in the same columns: where it lives, Open, and Delete, which the direct message, never
 * deleted, has as Clear. A pencil beside the title renames it (a contact note has none). Delete and Clear ask in
 * a box under the button, so the row itself never changes width. SPEC-003 FR-12 and FR-14: above them, the
 * bot-wide display switches.
 */

const api = window.catsBot;

type PanelKind = 'layer' | 'remove';

interface Panel {
  kind: PanelKind;
  id: string;
  trigger: HTMLButtonElement;
}

function RenameField({ record, onDone }: { record: ConversationRecord; onDone(): void }) {
  useI18n();
  const toast = useToast();
  const [title, setTitle] = useState(record.title);
  const done = useRef(false);
  const finish = async (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const next = title.trim();
    if (save && next && next !== record.title) {
      try {
        await api.invoke('renameConversation', record.id, next);
      } catch (failure) {
        toast(t('Could not rename: {value0}', { value0: errorText(failure) }));
      }
    }
    onDone();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') void finish(true);
    if (event.key === 'Escape') void finish(false);
  };
  return (
    <input
      className="note-rename-field"
      autoFocus
      maxLength={80}
      aria-label={t('New name')}
      value={title}
      onFocus={(event) => event.target.select()}
      onChange={(event) => setTitle(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => void finish(true)}
    />
  );
}

/** The layers stacked from the top of the screen down; the one the note lives on is the long amber bar. */
function LayerGlyph({ stack, layer }: { stack: readonly NoteLayer[]; layer: NoteLayer }) {
  const at = stack.indexOf(layer);
  return (
    <svg className="note-layer-glyph" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      {stack.map((option, index) => (
        <rect
          key={option}
          className={index === at ? 'is-here' : undefined}
          x={index === at ? 0 : 1.5}
          y={5.75 + (index - (stack.length - 1) / 2) * 3.5}
          width={index === at ? 14 : 11}
          height="2.5"
          rx="1.25"
        />
      ))}
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M11.3 1.9a1.6 1.6 0 0 1 2.3 0l.5.5a1.6 1.6 0 0 1 0 2.3L6 12.8l-3.3.8.8-3.3z" fill="none"
        stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg className="note-layer-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/**
 * A menu or confirmation over the list, under its button (above it near the window's bottom), which never moves
 * a row. Escape returns to the button; a click elsewhere, a scroll or leaving the window closes it.
 */
function Popover({ trigger, label, role, onClose, children }: {
  trigger: HTMLButtonElement;
  label: string;
  role: 'menu' | 'dialog';
  onClose(returnFocus: boolean): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const anchor = trigger.getBoundingClientRect();
    const below = anchor.bottom + 6;
    const top = below + node.offsetHeight > window.innerHeight - 8 ? Math.max(8, anchor.top - node.offsetHeight - 6) : below;
    const left = Math.max(8, Math.min(anchor.right - node.offsetWidth, window.innerWidth - node.offsetWidth - 8));
    setPlace({ top, left });
  }, [trigger]);
  // Focus goes in once it is placed: a box still hidden for measuring cannot take it.
  const placed = place !== null;
  useEffect(() => {
    if (!placed) return;
    const node = ref.current;
    (node?.querySelector<HTMLElement>('[data-initial-focus]') ?? node?.querySelector<HTMLElement>('button'))?.focus();
  }, [placed]);
  useEffect(() => {
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !trigger.contains(target)) onClose(false);
    };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose(true);
    };
    const gone = (event: Event) => {
      if (event.type === 'scroll' && ref.current?.contains(event.target as Node)) return;
      onClose(false);
    };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', key);
    document.addEventListener('scroll', gone, true);
    window.addEventListener('resize', gone);
    window.addEventListener('blur', gone);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', key);
      document.removeEventListener('scroll', gone, true);
      window.removeEventListener('resize', gone);
      window.removeEventListener('blur', gone);
    };
  }, [trigger, onClose]);
  return (
    <div
      ref={ref}
      className="note-pop"
      role={role}
      aria-label={label}
      style={place ? { top: place.top, left: place.left } : { top: 0, left: 0, visibility: 'hidden' }}
    >
      {children}
    </div>
  );
}

function LayerMenu({ layer, layers, onChosen, onClose }: {
  layer: NoteLayer;
  layers: NoteLayersView;
  onChosen(layer: NoteLayer): void;
  onClose(returnFocus: boolean): void;
}) {
  useI18n();
  const stack = layerStack(layers.layers);
  const list = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  };
  return (
    <div className="note-menu" ref={list} onKeyDown={onKeyDown}>
      {stack.map((option) => (
        <button
          key={option}
          type="button"
          role="menuitemradio"
          aria-checked={option === layer}
          data-initial-focus={option === layer ? '' : undefined}
          className="note-menu-item"
          title={t(layers.labels[option])}
          onClick={() => {
            onClose(true);
            if (option !== layer) onChosen(option);
          }}
        >
          <LayerGlyph stack={stack} layer={option} />
          <span className="note-menu-name">{t(NOTE_LAYER_NAMES[option].name)}</span>
          <span className="note-menu-detail">{t(NOTE_LAYER_NAMES[option].detail)}</span>
        </button>
      ))}
    </div>
  );
}

function RemoveConfirm({ record, telegram, onClose, onRemoved }: {
  record: ConversationRecord;
  telegram: boolean;
  onClose(returnFocus: boolean): void;
  onRemoved(): void;
}) {
  useI18n();
  const toast = useToast();
  const [working, setWorking] = useState(false);
  const copy = removalCopy(record, telegram);
  const clearing = record.role === 'home';
  const confirm = async () => {
    setWorking(true);
    try {
      if (clearing) await api.invoke('clearConversation', record.id);
      else await api.invoke('deleteConversation', record.id);
      toast(copy.done);
    } catch (failure) {
      toast(clearing
        ? t('Could not clear: {value0}', { value0: errorText(failure) })
        : t('Could not delete: {value0}', { value0: errorText(failure) }));
    }
    onClose(clearing);
    onRemoved();
  };
  return (
    <div className="note-confirm">
      <h3>{copy.title}</h3>
      <p>{copy.detail}</p>
      <div className="note-confirm-actions">
        <button type="button" className="note-control" data-initial-focus="" disabled={working} onClick={() => onClose(true)}>
          {t('Cancel')}
        </button>
        <button type="button" className="note-control danger armed" disabled={working} onClick={() => void confirm()}>
          {working ? (clearing ? t('Clearing…') : t('Deleting…')) : copy.action}
        </button>
      </div>
    </div>
  );
}

function NoteRow({ record, layer, layers, renaming, open, onRename, onRenamed, onPanel }: {
  record: ConversationRecord;
  layer: NoteLayer;
  layers: NoteLayersView;
  renaming: boolean;
  open: PanelKind | null;
  onRename(): void;
  onRenamed(): void;
  onPanel(kind: PanelKind, trigger: HTMLButtonElement): void;
}) {
  useI18n();
  const title = conversationTitle(record);
  const stack = layerStack(layers.layers);
  return (
    <li className="note-row" data-id={record.id}>
      <div className="note-main">
        <div className="note-title">
          {renaming ? (
            <RenameField record={record} onDone={onRenamed} />
          ) : (
            <>
              <span className="note-title-text" title={title}>{title}</span>
              {record.role === 'home' && title !== t('Direct message') && (
                <span className="badge home">{t('Direct message')}</span>
              )}
              {record.unreadCount > 0 && <span className="badge">{t('{count} unread', { count: record.unreadCount })}</span>}
              {!record.contactOf && (
                // SPEC-012 FR-6: a contact note is named after the other bot and is not renamed.
                <button
                  type="button"
                  className="note-rename"
                  title={t('Rename')}
                  aria-label={t('Rename {value0}', { value0: title })}
                  onClick={onRename}
                >
                  <PencilIcon />
                </button>
              )}
            </>
          )}
        </div>
        <div className="note-meta">{noteMeta(record)}</div>
      </div>
      <button
        type="button"
        className="note-control note-layer"
        aria-haspopup="menu"
        aria-expanded={open === 'layer'}
        aria-label={`${t('Where this conversation lives')}: ${t(layers.labels[layer])}`}
        title={t(layers.labels[layer])}
        onClick={(event) => onPanel('layer', event.currentTarget)}
      >
        <LayerGlyph stack={stack} layer={layer} />
        <span className="note-layer-name">{t(NOTE_LAYER_NAMES[layer].name)}</span>
        <ChevronIcon />
      </button>
      <button type="button" className="note-control" onClick={() => void api.window.openConversation(record.id)}>
        {t('Open')}
      </button>
      <button
        type="button"
        className="note-control note-remove"
        aria-haspopup="dialog"
        aria-expanded={open === 'remove'}
        onClick={(event) => onPanel('remove', event.currentTarget)}
      >
        {record.role === 'home' ? t('Clear') : t('Delete')}
      </button>
    </li>
  );
}

type DisplaySetting = 'showProgressDetails' | 'showVerboseMessages';

/**
 * SPEC-003 FR-12 and FR-14: Cats Desktop's two conversation display switches, one each for every note of this
 * bot, saved as they change.
 */
function DisplaySwitch({ setting, id, label, hint }: { setting: DisplaySetting; id: string; label: string; hint: string }) {
  useI18n();
  const toast = useToast();
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => api.invoke('getProfile').then((profile) => { if (live) setOn(profile[setting]); });
    void read().catch(() => undefined);
    const offEvent = api.onEvent((event) => { if (event.type === 'profile.updated') void read().catch(() => undefined); });
    return () => { live = false; offEvent(); };
  }, [setting]);
  const change = async (next: boolean) => {
    setOn(next);
    try {
      await api.invoke('updateProfile', { [setting]: next });
    } catch (failure) {
      setOn(!next);
      toast(t('Could not save: {value0}', { value0: errorText(failure) }));
    }
  };
  return (
    <div className="display-switch">
      <label className="check">
        <input type="checkbox" id={id} checked={on === true} disabled={on === null}
          onChange={(event) => void change(event.target.checked)} />
        <span>{label}</span>
      </label>
      <p className="hint">{hint}</p>
    </div>
  );
}

export function NotesTab() {
  useI18n();
  const toast = useToast();
  const [records, setRecords] = useState<ConversationRecord[]>([]);
  const [layers, setLayers] = useState<NoteLayersView | null>(null);
  const [telegram, setTelegram] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const panelRef = useRef<Panel | null>(null);
  panelRef.current = panel;
  const [renaming, setRenaming] = useState<string | null>(null);
  // While a menu, a confirmation or a name field is open, a redraw would take it away; the list is read again
  // once it closes.
  const held = useRef(false);
  const stale = useRef(false);

  const load = useCallback(async () => {
    const [view, list] = await Promise.all([api.shell.noteLayers(), api.invoke('listConversations')]);
    setLayers(view);
    setRecords(sortNotes(list));
  }, []);
  const refresh = useCallback(() => {
    if (held.current) stale.current = true;
    else void load();
  }, [load]);

  useEffect(() => {
    held.current = panel !== null || renaming !== null;
    if (!held.current && stale.current) {
      stale.current = false;
      void load();
    }
  }, [panel, renaming, load]);

  useEffect(() => {
    let live = true;
    const readTelegram = () => Promise.all([api.invoke('getProfile'), api.invoke('telegramStatus')])
      .then(([profile, status]) => { if (live) setTelegram(reachesTelegram(profile.telegram, status.tokenStored === true)); })
      .catch(() => undefined);
    void load();
    void readTelegram();
    const offEvent = api.onEvent((event) => {
      if (event.type === 'conversation.updated' || event.type === 'conversation.cleared') refresh();
      if (event.type === 'profile.updated') void readTelegram();
    });
    // A note's layer can change from its own header; show the current one when the window comes back.
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      live = false;
      offEvent();
      window.removeEventListener('focus', onFocus);
    };
  }, [load, refresh]);

  const create = async () => {
    const record = await api.invoke('createConversation');
    await api.window.openConversation(record.id);
    await load();
  };

  const closePanel = useCallback((returnFocus: boolean) => {
    const current = panelRef.current;
    setPanel(null);
    if (current && returnFocus && current.trigger.isConnected) current.trigger.focus();
  }, []);

  const togglePanel = (kind: PanelKind, id: string, trigger: HTMLButtonElement) => {
    setPanel((current) => (current?.kind === kind && current.id === id ? null : { kind, id, trigger }));
  };

  const setLayer = async (record: ConversationRecord, layer: NoteLayer) => {
    if (!layers) return;
    await api.shell.setNoteLayer(record.id, layer);
    toast(`${conversationTitle(record)}: ${t(layers.labels[layer])}`);
    await load();
  };

  const open = panel ? records.find((record) => record.id === panel.id) ?? null : null;
  const layerOf = (record: ConversationRecord): NoteLayer => layers?.views[record.id] ?? 'normal';

  return (
    <section className="panel" data-panel="notes">
      <div className="panel-head">
        <h2>{t('Conversations')}</h2>
        <button className="primary" id="notes-new" onClick={() => void create()}>
          {t('New conversation')}
        </button>
      </div>
      <p className="lead">{t('Each conversation keeps its own history. Closing its window only hides it.')}</p>
      <div className="display-switches">
        {/* In Cats Desktop's order: verbose messages, then live progress details. */}
        <DisplaySwitch setting="showVerboseMessages" id="notes-verbose-messages" label={t('Show verbose messages')}
          hint={t('Keep system-level session and orchestration messages visible in every conversation of this cat bot.')} />
        <DisplaySwitch setting="showProgressDetails" id="notes-progress-details" label={t('Show live progress details')}
          hint={t('For every conversation of this cat bot: a reply shows its tool steps while it runs, and each finished reply gets a link that opens them.')} />
      </div>
      <ul className="notes" id="notes-list">
        {layers &&
          records.map((record) => (
            <NoteRow
              key={record.id}
              record={record}
              layer={layerOf(record)}
              layers={layers}
              renaming={renaming === record.id}
              open={panel?.id === record.id ? panel.kind : null}
              onRename={() => {
                setPanel(null);
                setRenaming(record.id);
              }}
              onRenamed={() => setRenaming(null)}
              onPanel={(kind, trigger) => togglePanel(kind, record.id, trigger)}
            />
          ))}
      </ul>
      {panel && open && layers && panel.kind === 'layer' && (
        <Popover trigger={panel.trigger} role="menu" label={t('Where this conversation lives')} onClose={closePanel}>
          <LayerMenu
            layer={layerOf(open)}
            layers={layers}
            onChosen={(layer) => void setLayer(open, layer)}
            onClose={closePanel}
          />
        </Popover>
      )}
      {panel && open && panel.kind === 'remove' && (
        <Popover trigger={panel.trigger} role="dialog" label={removalCopy(open, telegram).title} onClose={closePanel}>
          <RemoveConfirm record={open} telegram={telegram} onClose={closePanel} onRemoved={() => void load()} />
        </Popover>
      )}
    </section>
  );
}
