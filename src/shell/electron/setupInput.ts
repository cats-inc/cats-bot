/**
 * SPEC-002 FR-1: what the first-run page may hand to `initializeBot`. The
 * page is our own, but its input still crosses IPC, so it is checked here
 * (Electron-free, so it can be tested without a window).
 */

import { CLI_PROVIDERS } from '../../core/providers/catalog.ts';
import { parseModelSelection } from '../../core/providers/selection.ts';
import type { ModelSelection } from '../../core/types.ts';
import { isBotAvatar, type BotAvatar } from '../../shared/avatars.ts';
import { checkedBotName, checkedBotPersona } from '../../shared/botText.ts';

export interface SetupInput {
  name: string;
  provider: string;
  model: string | null;
  instructions: string;
  modelSelection?: ModelSelection;
  /** SPEC-008 FR-29: without one, the bot gets a look no bot uses yet. */
  avatar?: BotAvatar;
  /** SPEC-010 FR-17: a first run's choice; without one it starts at login where that is offered. */
  startAtLogin?: boolean;
}

const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,39}$/u;

export function validateSetupInput(raw: unknown): SetupInput {
  if (typeof raw !== 'object' || raw === null) throw new Error('Setup input must be an object');
  const record = raw as Record<string, unknown>;
  const name = checkedBotName(typeof record.name === 'string' ? record.name : '');
  const provider = typeof record.provider === 'string' ? record.provider.trim() : '';
  if (!PROVIDER_PATTERN.test(provider) || !CLI_PROVIDERS.some((item) => item.id === provider))
    throw new Error('Choose an agent CLI');
  const model = typeof record.model === 'string' && record.model.trim() ? record.model.trim() : null;
  if (model && model.length > 200) throw new Error('A model id has at most 200 characters');
  const instructions = checkedBotPersona(typeof record.instructions === 'string' ? record.instructions : '');
  const modelSelection = parseModelSelection(record.modelSelection);
  if (record.avatar !== undefined && !isBotAvatar(record.avatar)) throw new Error('Choose one of the Cat looks');
  return {
    name,
    provider,
    model,
    instructions,
    ...(modelSelection ? { modelSelection } : {}),
    ...(record.avatar !== undefined ? { avatar: record.avatar } : {}),
    ...(typeof record.startAtLogin === 'boolean' ? { startAtLogin: record.startAtLogin } : {}),
  };
}
