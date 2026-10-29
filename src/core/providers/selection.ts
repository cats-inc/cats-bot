import type { ModelSelection } from '../types.ts';

/** Validate the public Runtime selection envelope; Runtime validates catalog membership. */
export function parseModelSelection(value: unknown): ModelSelection | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid model selection');
  const raw = value as Record<string, unknown>;
  if (
    raw.entryMode !== 'explicit' ||
    typeof raw.entryId !== 'string' ||
    !raw.entryId.trim() ||
    raw.entryId.length > 200
  )
    throw new Error('Choose a catalog model');
  if (
    raw.catalogRevision !== undefined &&
    (typeof raw.catalogRevision !== 'string' ||
      !raw.catalogRevision ||
      raw.catalogRevision.length > 200)
  )
    throw new Error('Invalid catalog revision');
  const controls: Record<string, string | number | boolean> = {};
  if (raw.controls !== undefined) {
    if (!raw.controls || typeof raw.controls !== 'object' || Array.isArray(raw.controls))
      throw new Error('Invalid model controls');
    for (const [key, item] of Object.entries(raw.controls).sort(([a], [b]) => a.localeCompare(b))) {
      if (
        key.length > 200 ||
        !['string', 'number', 'boolean'].includes(typeof item) ||
        (typeof item === 'number' && !Number.isFinite(item))
      )
        throw new Error('Invalid model control');
      controls[key] = item as string | number | boolean;
    }
  }
  return {
    entryMode: 'explicit',
    entryId: raw.entryId,
    ...(raw.catalogRevision ? { catalogRevision: raw.catalogRevision as string } : {}),
    ...(Object.keys(controls).length ? { controls } : {}),
  };
}
