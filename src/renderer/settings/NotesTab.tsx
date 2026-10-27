import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

import type { ConversationRecord } from '../../core/types.ts';
import type { NoteLayer, NoteLayersView } from '../bridge.ts';
import { errorText } from '../errors.ts';
import { noteMeta, sortNotes } from './settingsLogic.ts';
import { useToast } from './toast.ts';

/**
 * SPEC-002 FR-5, FR-8: every conversation with its unread count, session
 * state and layer; open, add, rename and delete (twice to confirm).
 */

const api = window.catsBot;
const ARM_MS = 4000;

function RenameField({ record, onDone }: { record: ConversationRecord; onDone(): void }) {
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
        toast(`Could not rename: ${errorText(failure)}`);
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
      autoFocus
      maxLength={80}
      value={title}
      onFocus={(event) => event.target.select()}
      onChange={(event) => setTitle(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => void finish(true)}
    />
  );
}

function NoteRow({ record, layers, onChanged }: { record: ConversationRecord; layers: NoteLayersView; onChanged(): void }) {
  const toast = useToast();
  const [renaming, setRenaming] = useState(false);
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(armTimer.current), []);

  const remove = async () => {
    if (!armed) {
      setArmed(true);
      armTimer.current = setTimeout(() => setArmed(false), ARM_MS);
      return;
    }
    clearTimeout(armTimer.current);
    try {
      await api.invoke('deleteConversation', record.id);
      toast(`Deleted ${record.title}`);
      onChanged();
    } catch (failure) {
      toast(`Could not delete: ${errorText(failure)}`);
    }
  };

  const setLayer = async (layer: NoteLayer) => {
    await api.shell.setNoteLayer(record.id, layer);
    toast(`${record.title}: ${layers.labels[layer]}`);
    onChanged();
  };

  return (
    <li className="note-row" data-id={record.id}>
      <div className="main">
        {renaming ? (
          <RenameField
            record={record}
            onDone={() => {
              setRenaming(false);
              onChanged();
            }}
          />
        ) : (
          <>
            <div className="title">
              {record.title}
              {record.role === 'home' && <span className="badge home">home</span>}
              {record.unreadCount > 0 && <span className="badge">{record.unreadCount} unread</span>}
            </div>
            <div className="meta">{noteMeta(record)}</div>
          </>
        )}
      </div>
      {!renaming && (
        <>
          <select
            className="layer"
            title="Where this note lives"
            value={layers.views[record.id] ?? 'normal'}
            onChange={(event) => void setLayer(event.target.value as NoteLayer)}
          >
            {layers.layers.map((layer) => (
              <option key={layer} value={layer}>
                {layers.labels[layer]}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => void api.window.openConversation(record.id)}>
            Open
          </button>
          <button type="button" onClick={() => setRenaming(true)}>
            Rename
          </button>
          {record.role !== 'home' && (
            <button type="button" className={armed ? 'danger armed' : 'danger'} onClick={() => void remove()}>
              {armed ? 'Delete for good?' : 'Delete'}
            </button>
          )}
        </>
      )}
    </li>
  );
}

export function NotesTab() {
  const [records, setRecords] = useState<ConversationRecord[]>([]);
  const [layers, setLayers] = useState<NoteLayersView | null>(null);

  const load = useCallback(async () => {
    const [view, list] = await Promise.all([api.shell.noteLayers(), api.invoke('listConversations')]);
    setLayers(view);
    setRecords(sortNotes(list));
  }, []);

  useEffect(() => {
    void load();
    // Not while the owner is in a row (renaming, picking a layer): a redraw would take the input away.
    const offEvent = api.onEvent((event) => {
      if (event.type === 'conversation.updated' && !document.activeElement?.closest('.note-row')) void load();
    });
    // A note's layer can change from its own header; show the current one when the window comes back.
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      offEvent();
      window.removeEventListener('focus', onFocus);
    };
  }, [load]);

  const create = async () => {
    const record = await api.invoke('createConversation');
    await api.window.openConversation(record.id);
    await load();
  };

  return (
    <section className="panel" data-panel="notes">
      <div className="panel-head">
        <h2>Notes</h2>
        <button className="primary" id="notes-new" onClick={() => void create()}>
          New note
        </button>
      </div>
      <p className="lead">
        Every note is its own conversation with the bot. Closing a note only hides it. A note on the desktop stays there
        under your windows (Show Desktop keeps it); click it to type and it comes forward until you click elsewhere. A
        note on the wallpaper sits below the icons; open it here to use it.
      </p>
      <ul className="notes" id="notes-list">
        {layers && records.map((record) => <NoteRow key={record.id} record={record} layers={layers} onChanged={() => void load()} />)}
      </ul>
    </section>
  );
}
