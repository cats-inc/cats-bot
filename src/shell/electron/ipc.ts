import { CORE_COMMANDS, runCoreCommand, type CoreCommandTarget } from '../../core/host-api/commands.ts';

/**
 * SPEC-001 FR-32 / FR-34: the command side of `BotHostApi` as the renderer
 * may call it. The commands and their argument checks live in the core
 * (`src/core/host-api/commands.ts`), shared with the host channel; this layer
 * adds which window may send which command and the one command that needs the
 * shell itself, opening a provider's URL request. Window-only commands (hide,
 * pin) are handled by the window layer, not here.
 */

export type HostCommand = (typeof CORE_COMMANDS)[number] | 'openProviderInteractionUrl';

export const HOST_COMMANDS: readonly HostCommand[] = [...CORE_COMMANDS, 'openProviderInteractionUrl'];

/**
 * Commands only the note of the named conversation may send. SPEC-006 BDC-07: grants are
 * answered there or in the CLI, never from Settings, the floating cat or a provider request.
 */
export const NOTE_ONLY_COMMANDS: readonly HostCommand[] = [
  'conversationTranscript',
  'providerInteractions', 'respondProviderInteraction', 'openProviderInteractionUrl',
  'setConversationDesktopControl', 'respondDesktopGrant', 'stopDesktopControl',
];

/** The window a `bot:invoke` came from: a note's conversation, Settings or the floating cat. */
export interface CommandSender {
  note: string | null;
  settings: boolean;
  floating: boolean;
}

/**
 * Whether that window may send the command with these arguments. A note acts only on its own
 * conversation; desktop control state is read by its own note, or at the profile level
 * (no conversation) by Settings, whose switch it shows.
 */
export function senderMayInvoke(command: string, args: unknown[], sender: CommandSender): boolean {
  if (sender.note === null && !sender.settings && !sender.floating) return false;
  if (NOTE_ONLY_COMMANDS.includes(command as HostCommand)) return sender.note !== null && args[0] === sender.note;
  if (command === 'desktopControlState') {
    return sender.note !== null ? args[0] === sender.note : sender.settings && (args[0] === undefined || args[0] === null);
  }
  return true;
}

function asString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a non-empty string`);
  return value;
}

export async function runHostCommand(core: CoreCommandTarget, command: string, args: unknown[], openExternal?: (url: string) => Promise<void>): Promise<unknown> {
  if (command === 'openProviderInteractionUrl') {
    const snapshot = await core.providerInteractions(asString(args[0], 'conversationId'));
    if (!snapshot.supported) throw new Error('The provider request cannot currently be verified.');
    const interaction = snapshot.interactions.find(i => i.interactionId === asString(args[1], 'interactionId'));
    if (!interaction?.prompt?.url || interaction.kind !== 'mcp_url' || interaction.status !== 'pending'
      || Date.parse(interaction.expiresAt) <= Date.now() || !openExternal) throw new Error('No active URL request.');
    const url = new URL(interaction.prompt.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported request URL.');
    await openExternal(url.href);
    return null;
  }
  // Window lifecycle and quit stay with the window layer; a renderer cannot send them.
  if (!(CORE_COMMANDS as readonly string[]).includes(command)) throw new Error(`Unknown host command ${command}`);
  return runCoreCommand(core, command, args);
}
