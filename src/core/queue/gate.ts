/**
 * SPEC-001 FR-17: one turn at a time per runtime session, taken synchronously
 * so no dispatch can slip in before the operation starts; the runtime answers
 * 409 to a second concurrent message and has no queue of its own.
 *
 * Adapted from cats-platform
 * `src/products/chat/state/runtime-dispatch/sessionTurnGate.ts` at revision
 * 595e9ca (MIT), per ADR-001 §1.
 */

const heldSessions = new Map<string, Promise<void>>();

export function isSessionGateHeld(sessionId: string): boolean {
  return heldSessions.has(sessionId);
}

export function runWithSessionGate<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const previous = heldSessions.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = previous.then(() => released);
  heldSessions.set(sessionId, held);
  return (async () => {
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (heldSessions.get(sessionId) === held) {
        heldSessions.delete(sessionId);
      }
    }
  })();
}
