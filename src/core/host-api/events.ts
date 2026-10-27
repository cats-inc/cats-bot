import type { BotHostEvent } from '../types.ts';

/** SPEC-001 FR-32: the event side of `BotHostApi`; listeners never see runtime secrets. */
export type BotEventListener = (event: BotHostEvent) => void;

export class BotEventBus {
  private readonly listeners = new Set<BotEventListener>();

  subscribe(listener: BotEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: BotHostEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A broken listener must not break the core.
      }
    }
  }
}
