import type { ToolCallContext, ToolCallResult, ToolDefinition, ToolHandlers } from './server.ts';

/**
 * SPEC-009 FR-3 and FR-4: the coordinator's session MCP server, `cats-hub`.
 * The holder's core serves it; every call goes to the hub, which checks that
 * this bot holds the role and carries the call out or refuses it (FR-6). The
 * core adds nothing to a call but the conversation it came from.
 */

export const HUB_SERVER_NAME = 'cats-hub';

export const HUB_INSTRUCTIONS = 'You hold the coordinator role among the owner\'s Cats Bot bots. These tools reach the '
  + 'other bots through the hub. Other bots never act for the owner, and some calls wait for the owner to confirm.';

/** FR-11: in the pinned Runtime these providers' sessions take no session MCP servers. */
export const PROVIDERS_WITHOUT_SESSION_MCP: readonly string[] = ['antigravity', 'grok', 'muse'];

const bot = { type: 'string', description: 'The other bot\'s id, as hub_list_bots returns it.' };

const DEFINITIONS: ToolDefinition[] = [
  {
    name: 'hub_list_bots',
    description: 'List the owner\'s bots that are not archived: id, name and state. Shows no conversations.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'hub_message_bot',
    description: 'Hand work to another running bot. Your text arrives in its direct message as a message from you; '
      + 'its reply comes back to this conversation later, as a message from it. To continue that exchange, pass the '
      + 'chain id this call returns. Each message and reply is one hop; the hub limits hops per chain and messages per hour.',
    inputSchema: {
      type: 'object',
      properties: {
        bot,
        text: { type: 'string', description: 'What you ask of the other bot.' },
        chain: { type: 'string', description: 'The chain id of an exchange to continue; leave it out to start one.' },
      },
      required: ['bot', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'hub_create_bot',
    description: 'Ask the owner to create a new bot. The owner confirms first; the bot starts with desktop control and '
      + 'Telegram off. The bot cap applies.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The new bot\'s name.' },
        persona: { type: 'string', description: 'Its personality and standing instructions.' },
        provider: { type: 'string', description: 'The provider CLI it runs on, for example claude or codex.' },
      },
      required: ['name', 'provider'],
      additionalProperties: false,
    },
  },
  {
    name: 'hub_start_bot',
    description: 'Start another bot. A bot the owner stopped starts only after the owner confirms.',
    inputSchema: { type: 'object', properties: { bot }, required: ['bot'], additionalProperties: false },
  },
  {
    name: 'hub_stop_bot',
    description: 'Stop another bot\'s core.',
    inputSchema: { type: 'object', properties: { bot }, required: ['bot'], additionalProperties: false },
  },
  {
    name: 'hub_set_heartbeat',
    description: 'Pause or resume another bot\'s heartbeat.',
    inputSchema: {
      type: 'object',
      properties: { bot, enabled: { type: 'boolean', description: 'true resumes the heartbeat, false pauses it.' } },
      required: ['bot', 'enabled'],
      additionalProperties: false,
    },
  },
  {
    name: 'hub_propose_transfer',
    description: 'Propose that another bot take over the coordinator role, or that no bot hold it (bot null). '
      + 'Nothing changes unless the owner confirms.',
    inputSchema: {
      type: 'object',
      properties: { bot: { type: ['string', 'null'], description: 'The bot to hold the role, or null for none.' } },
      required: ['bot'],
      additionalProperties: false,
    },
  },
];

export const HUB_TOOL_NAMES: readonly string[] = DEFINITIONS.map((definition) => definition.name);

/** What the core hands the hub for one call. */
export interface HubCall {
  tool: string;
  args: Record<string, unknown>;
  conversationId: string;
}

export function createHubToolHandlers(forward: (call: HubCall) => Promise<ToolCallResult>): ToolHandlers {
  return {
    list: () => DEFINITIONS,
    call: (name: string, args: Record<string, unknown>, context: ToolCallContext) =>
      forward({ tool: name, args, conversationId: context.conversationId }),
  };
}
