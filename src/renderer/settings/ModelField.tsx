import { useEffect, useRef, useState } from 'react';

import type { ModelCatalog } from '../../core/types.ts';
import { CUSTOM_MODEL, emptyCatalog, modelOptions, modelSelection, modelSourceHint, readModel, RequestGate } from './settingsLogic.ts';

export interface ModelMenu {
  loading: boolean;
  /** The provider the catalog belongs to; a menu for another provider is not ready. */
  provider: string | null;
  catalog: ModelCatalog | null;
  select: string;
  custom: string;
}

const LOADING: ModelMenu = { loading: true, provider: null, catalog: null, select: '', custom: '' };

/**
 * The model menu of one provider (SPEC-002 FR-3, SPEC-003 FR-6). Only the
 * newest request fills it; while it loads the previous provider's models are
 * gone, so a form cannot be saved with them. A failed lookup leaves the
 * provider default and a typed id. `preselect` is the saved model when the
 * provider is the saved one.
 */
export function useModelMenu(provider: string, preselect: string | null, fetchCatalog: (provider: string) => Promise<ModelCatalog>) {
  const gate = useRef(new RequestGate());
  const [menu, setMenu] = useState<ModelMenu>(LOADING);
  useEffect(() => {
    if (!provider) return;
    const ticket = gate.current.begin();
    setMenu(LOADING);
    void fetchCatalog(provider)
      .catch(() => emptyCatalog(provider))
      .then((catalog) => {
        if (gate.current.isLatest(ticket)) setMenu({ loading: false, provider, catalog, ...modelSelection(catalog, preselect) });
      });
  }, [provider, preselect, fetchCatalog]);
  // Ready only for the provider shown now, also in the render before the effect above marks it loading.
  const ready = !menu.loading && menu.provider === provider && menu.catalog !== null;
  return { menu: ready ? menu : { ...menu, loading: true }, setMenu, ready, model: readModel(menu.select, menu.custom) };
}

export function ModelField({ idPrefix, menu, onChange, showSource = false }: {
  idPrefix: string;
  menu: ModelMenu;
  onChange(menu: ModelMenu): void;
  showSource?: boolean;
}) {
  const customRef = useRef<HTMLInputElement>(null);
  const [focusCustom, setFocusCustom] = useState(false);
  useEffect(() => {
    if (!focusCustom) return;
    customRef.current?.focus();
    setFocusCustom(false);
  }, [focusCustom]);
  const ready = !menu.loading && menu.catalog !== null;
  return (
    <label className="field">
      <span>Model</span>
      <select
        id={`${idPrefix}-model`}
        disabled={!ready}
        value={ready ? menu.select : ''}
        onChange={(event) => {
          onChange({ ...menu, select: event.target.value });
          if (event.target.value === CUSTOM_MODEL) setFocusCustom(true);
        }}
      >
        {ready && menu.catalog
          ? modelOptions(menu.catalog).map((option) => (
            <option key={option.value} value={option.value}>
              {option.text}
            </option>
          ))
          : <option value="">Loading models…</option>}
      </select>
      <input
        id={`${idPrefix}-model-custom`}
        ref={customRef}
        placeholder="Model id"
        hidden={!ready || menu.select !== CUSTOM_MODEL}
        value={menu.custom}
        onChange={(event) => onChange({ ...menu, custom: event.target.value })}
      />
      {showSource && (
        <small className="hint" id={`${idPrefix}-model-hint`}>
          {ready && menu.catalog ? modelSourceHint(menu.catalog.source) : ''}
        </small>
      )}
    </label>
  );
}
