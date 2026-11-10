/**
 * ADR-020 (as Cats Desktop's ADR-147): the macOS System Settings panes Cats Bot
 * opens for a missing permission. A window names a pane; only the shell knows
 * its URL. No imports: the note and Settings read it too.
 */
export const SYSTEM_SETTINGS_PANES = [
  'microphone',
  'speech_recognition',
  'screen_recording',
  'login_items',
] as const;

export type SystemSettingsPane = typeof SYSTEM_SETTINGS_PANES[number];

const PANE_SET = new Set<string>(SYSTEM_SETTINGS_PANES);

export function isSystemSettingsPane(value: unknown): value is SystemSettingsPane {
  return typeof value === 'string' && PANE_SET.has(value);
}
