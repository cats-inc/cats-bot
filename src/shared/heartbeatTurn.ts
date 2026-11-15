/**
 * SPEC-001 FR-25: what marks a heartbeat turn, shared by the core, which runs it as one, and the note, which
 * awaits no reply from it (SPEC-003 FR-18). It has no imports, so the page can take it.
 */
export const HEARTBEAT_PROMPT_PREFIX = '[Cats heartbeat.';

export function isHeartbeatPrompt(prompt: string): boolean {
  return prompt.startsWith(HEARTBEAT_PROMPT_PREFIX);
}

/** A heartbeat, or an interrupted one the owner had run again, which arrives as an owner message. */
export function isHeartbeatTurn(item: { kind: string; prompt: string }): boolean {
  return item.kind === 'heartbeat' || isHeartbeatPrompt(item.prompt);
}
