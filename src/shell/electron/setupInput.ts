/**
 * SPEC-002 FR-1: what the first-run page may hand to `initializeBot`. The
 * page is our own, but its input still crosses IPC, so it is checked here
 * (Electron-free, so it can be tested without a window).
 */

import { CLI_PROVIDERS } from '../../core/providers/catalog.ts';
import { parseModelSelection } from '../../core/providers/selection.ts';
import type { ModelSelection } from '../../core/types.ts';

export interface SetupInput {
  name: string;
  provider: string;
  model: string | null;
  instructions: string;
  modelSelection?: ModelSelection;
}

const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,39}$/u;

export function validateSetupInput(raw: unknown): SetupInput {
  if (typeof raw !== 'object' || raw === null) throw new Error('Setup input must be an object');
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!name) throw new Error('Give the bot a name');
  if (name.length > 40) throw new Error('A name has at most 40 characters');
  const provider = typeof record.provider === 'string' ? record.provider.trim() : '';
  if (!PROVIDER_PATTERN.test(provider) || !CLI_PROVIDERS.some((item) => item.id === provider))
    throw new Error('Choose an agent CLI');
  const model = typeof record.model === 'string' && record.model.trim() ? record.model.trim() : null;
  if (model && model.length > 200) throw new Error('A model id has at most 200 characters');
  const instructions = typeof record.instructions === 'string' ? record.instructions.trim() : '';
  const modelSelection = parseModelSelection(record.modelSelection);
  return { name, provider, model, instructions, ...(modelSelection ? { modelSelection } : {}) };
}
