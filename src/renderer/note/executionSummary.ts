import type { ExecutionTarget, ModelCatalog, ModelControl, ModelControlValue } from '../../core/types.ts';

/**
 * SPEC-003 FR-11: the note header face's model line, composed as Cats Desktop's audience chip composes a cat's
 * tooltip ("QQ · Claude-CLI · Opus 5.5 · xHigh"): the cat's name, the provider with its CLI backend, the
 * model's catalog label and the label of each control the target chooses, none of them translated. A bot on
 * the provider default is named by the catalog's default selection. Without a catalog it falls back to the ids.
 */
export function executionSummary(catName: string, target: ExecutionTarget, catalog: ModelCatalog | null): string {
  const usesDefault = !target.modelSelection && !target.model;
  const entryId = target.modelSelection?.entryId ?? target.model
    ?? catalog?.defaultSelection?.entryId ?? catalog?.defaultModel ?? null;
  const model = entryId ? catalog?.models.find((option) => option.id === entryId) : undefined;
  const chosen = target.modelSelection?.controls
    ?? (usesDefault && catalog?.defaultSelection?.entryId === entryId ? catalog.defaultSelection.controls : undefined)
    ?? {};
  const controls = [...(model?.controls ?? []), ...(catalog?.controls ?? [])];
  const controlLabels = Object.entries(chosen)
    .filter(([, value]) => value !== '' && value !== false)
    .map(([key, value]) => valueLabel(controls.find((control) => control.key === key), value))
    .filter((label) => label.length > 0);
  return [catName.trim(), `${providerName(target.provider)}-CLI`, ...(entryId ? [withoutDefaultMark(model?.label ?? entryId)] : []),
    ...controlLabels].filter(Boolean).join(' · ');
}

/** Cats Desktop's provider display name: the id capitalized, OpenClaw as it spells itself. */
function providerName(provider: string): string {
  const id = provider.trim();
  return id === 'openclaw' ? 'OpenClaw' : id.charAt(0).toUpperCase() + id.slice(1);
}

/** Catalogs mark the default value in its label, "Medium (default)". */
function withoutDefaultMark(label: string): string {
  return label.replace(/\s*\(default\)\s*$/iu, '').trim();
}

function valueLabel(control: ModelControl | undefined, value: ModelControlValue): string {
  const entry = (control?.values ?? [])
    .map((option) => (typeof option === 'object' ? option : { value: option, label: String(option) }))
    .find((option) => option.value === value);
  return withoutDefaultMark(entry?.label ?? String(value));
}
