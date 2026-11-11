/** Same explicit confirmation as Cats Desktop's data reset dialog. */
export const BOT_DATA_RESET_CONFIRMATION = 'RESET';
export const BOT_DATA_RESET_JOURNAL = 'data-reset.pending.json';
export interface BotDataResetRequest { confirmation: string; resetRuntime: boolean }

export function isBotDataResetRequest(value: unknown): value is BotDataResetRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.confirmation === BOT_DATA_RESET_CONFIRMATION && typeof record.resetRuntime === 'boolean';
}
