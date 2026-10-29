import { t, useI18n } from '../i18n.ts';
import { useEffect, useRef, useState } from 'react';
import type { ModelCatalog, ModelSelection } from '../../core/types.ts';
import {
  controlOptions,
  modelControls,
  modelOptions,
  modelSelection,
  selectedModel,
  RequestGate,
} from './settingsLogic.ts';

export interface ModelMenu {
  loading: boolean;
  provider: string | null;
  catalog: ModelCatalog | null;
  select: string;
  custom: string;
  selection?: ModelSelection;
  edited?: boolean;
  error?: string;
}
const LOADING: ModelMenu = { loading: true, provider: null, catalog: null, select: '', custom: '' };

export function useModelMenu(
  provider: string,
  preselect: string | null,
  fetchCatalog: (provider: string) => Promise<ModelCatalog>,
  saved?: ModelSelection,
  preserveUnset = false,
) {
  const gate = useRef(new RequestGate());
  const [menu, setMenu] = useState<ModelMenu>(LOADING);
  useEffect(() => {
    const ticket = gate.current.begin();
    setMenu(LOADING);
    if (!provider) return;
    void fetchCatalog(provider)
      .then((catalog) => {
        if (!gate.current.isLatest(ticket)) return;
        const choice =
          preserveUnset && !saved && !preselect
            ? { select: '', custom: '' }
            : modelSelection(catalog, saved?.entryId ?? preselect);
        setMenu({
          loading: false,
          provider,
          catalog,
          ...choice,
          selection: selectedModel(catalog, choice.select, saved),
        });
      })
      .catch(() => {
        if (gate.current.isLatest(ticket))
          setMenu({
            ...LOADING,
            loading: false,
            provider,
            error: 'Could not load the model catalog. Try selecting the provider again.',
          });
      });
    return () => {
      gate.current.begin();
    };
  }, [provider, preselect, fetchCatalog, saved, preserveUnset]);
  const ready =
    !menu.loading &&
    menu.provider === provider &&
    Boolean(menu.catalog?.models.some((model) => model.id === menu.select));
  return {
    menu: menu.provider === provider ? menu : LOADING,
    setMenu,
    ready,
    model: menu.select || null,
    selection: menu.selection,
  };
}

export function ModelField({
  idPrefix,
  menu,
  onChange,
}: {
  idPrefix: string;
  menu: ModelMenu;
  onChange(menu: ModelMenu): void;
  showSource?: boolean;
}) {
  useI18n();
  const catalog = menu.catalog;
  const controls = catalog ? modelControls(catalog, menu.select) : [];
  const update = (next: ModelMenu) => onChange({ ...next, edited: true });
  return (
    <>
      <label className="field">
        <span>{t('Model')}</span>
        <select
          id={`${idPrefix}-model`}
          disabled={menu.loading || !catalog?.models.length}
          value={menu.select}
          onChange={(event) =>
            update({
              ...menu,
              select: event.target.value,
              custom: '',
              selection: selectedModel(catalog!, event.target.value),
            })
          }
        >
          {!menu.select && (
            <option value="" disabled hidden>
              {t('Choose a model')}
            </option>
          )}
          {catalog
            ? modelOptions(catalog).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.text}
                </option>
              ))
            : null}
        </select>
        {menu.loading && <small className="hint">{t('Loading models…')}</small>}
        {menu.error && (
          <small className="error" role="alert">
            {t(menu.error)}
          </small>
        )}
        {menu.custom && (
          <small className="hint warn">
            {t('The saved model is unavailable. It is kept until you choose another model.')}
          </small>
        )}
        {catalog && !catalog.models.length && (
          <small className="hint warn">{t('No models are available for this provider.')}</small>
        )}
      </label>
      {controls.map((control) => (
        <label className="field" key={control.key}>
          <span>{t(control.label)}</span>
          {control.kind === 'enum' ? (
            <select
              id={`${idPrefix}-${control.key}`}
              value={String(menu.selection?.controls?.[control.key] ?? '')}
              onChange={(event) => {
                const value = controlOptions(control).find(
                  (option) => String(option.value) === event.target.value,
                )?.value;
                if (value !== undefined && menu.selection)
                  update({
                    ...menu,
                    selection: {
                      ...menu.selection,
                      controls: { ...menu.selection.controls, [control.key]: value },
                    },
                  });
              }}
            >
              {controlOptions(control).map((option) => (
                <option key={String(option.value)} value={String(option.value)}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={`${idPrefix}-${control.key}`}
              type={
                control.kind === 'boolean'
                  ? 'checkbox'
                  : control.kind === 'number'
                    ? 'number'
                    : 'text'
              }
              checked={
                control.kind === 'boolean'
                  ? menu.selection?.controls?.[control.key] === true
                  : undefined
              }
              value={
                control.kind === 'boolean'
                  ? undefined
                  : String(menu.selection?.controls?.[control.key] ?? '')
              }
              min={control.minimum}
              max={control.maximum}
              step={control.step}
              onChange={(event) => {
                if (!menu.selection) return;
                const value =
                  control.kind === 'boolean'
                    ? event.target.checked
                    : control.kind === 'number'
                      ? Number(event.target.value)
                      : event.target.value;
                update({
                  ...menu,
                  selection: {
                    ...menu.selection,
                    controls: { ...menu.selection.controls, [control.key]: value },
                  },
                });
              }}
            />
          )}
        </label>
      ))}
    </>
  );
}
