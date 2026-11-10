/**
 * SPEC-001 FR-11 / FR-18: recognising that a Runtime session's provider-native
 * session can no longer be continued. The conversation itself is not lost: the
 * core owns its transcript and rebuilds a new Runtime session from it.
 */

/** Runtime's typed code for a provider session that cannot be resumed. */
export const PROVIDER_SESSION_UNAVAILABLE = 'provider_session_unavailable';

/**
 * Provider texts for the same condition, for Runtimes that do not send the
 * typed code yet. Each is the CLI saying it cannot find the session id it was
 * told to resume.
 */
const UNRESUMABLE_PROVIDER_TEXT: readonly RegExp[] = [
  // grok: "No saved copy of session <id> was found remotely. Check the id, …"
  /\bNo saved copy of session\b[^.]*\bwas found\b/iu,
  // claude: "No conversation found with session ID: <id>"
  /\bNo conversation found with session ID\b/iu,
];

export function isProviderSessionUnavailable(text: string | null | undefined, code?: string | null): boolean {
  if (code === PROVIDER_SESSION_UNAVAILABLE) return true;
  if (typeof text !== 'string' || !text) return false;
  return UNRESUMABLE_PROVIDER_TEXT.some((pattern) => pattern.test(text));
}

/** What the owner reads when a conversation continues in a rebuilt session. */
export const REBUILT_SESSION_NOTICE =
  'The previous session could not be continued; a new session starts with a handoff of what was said so far.';
