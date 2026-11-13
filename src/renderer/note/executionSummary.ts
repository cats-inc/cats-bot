import type { ExecutionTarget, ModelCatalog, ModelControl, ModelControlValue } from '../../core/types.ts';
import { t } from '../localeStore.ts';

/**
 * The note header's (i): which provider, model and reasoning effort the bot runs, named as its model catalog
 * names them ("Claude · Opus 5.5 · Medium effort"). Without a catalog it falls back to the ids it has.
 */
export function executionSummary(target: ExecutionTarget, catalog: ModelCatalog | null, providerLabel: string | null): string {
  const parts = [providerLabel?.trim() || target.provider];
  const usesDefault = !target.modelSelection && !target.model;
  const entryId = target.modelSelection?.entryId ?? target.model
    ?? catalog?.defaultSelection?.entryId ?? catalog?.defaultModel ?? null;
  const model = entryId ? catalog?.models.find((option) => option.id === entryId) : undefined;
  if (entryId) parts.push(model?.label ?? entryId);
  const control = effortControl([...(model?.controls ?? []), ...(catalog?.controls ?? [])], entryId);
  if (control) {
    const chosen = target.modelSelection?.controls?.[control.key]
      ?? (usesDefault && catalog?.defaultSelection?.entryId === entryId ? catalog.defaultSelection.controls?.[control.key] : undefined)
      ?? model?.controlDefaults?.[control.key]
      ?? control.default
      ?? markedDefault(control);
    if (chosen !== undefined) parts.push(t('{effort} effort', { effort: valueLabel(control, chosen) }));
  }
  return parts.join(' · ');
}

/** The reasoning-effort control that applies to `entryId`, whatever the provider prefixes its key with. */
function effortControl(controls: readonly ModelControl[], entryId: string | null): ModelControl | undefined {
  return controls.find((control) => /(?:^|[._])(?:reasoning_)?effort$/u.test(control.key)
    && (!control.applicableEntryIds || (entryId !== null && control.applicableEntryIds.includes(entryId))));
}

function entries(control: ModelControl): Array<{ value: ModelControlValue; label: string }> {
  return (control.values ?? []).map((value) => (typeof value === 'object' ? value : { value, label: String(value) }));
}

/** Catalogs mark the default value in its label, "Medium (default)". */
const DEFAULT_MARK = /\s*\(default\)\s*$/iu;

function markedDefault(control: ModelControl): ModelControlValue | undefined {
  return entries(control).find((entry) => DEFAULT_MARK.test(entry.label))?.value;
}

function valueLabel(control: ModelControl, value: ModelControlValue): string {
  const label = entries(control).find((entry) => entry.value === value)?.label ?? String(value);
  return label.replace(DEFAULT_MARK, '');
}
