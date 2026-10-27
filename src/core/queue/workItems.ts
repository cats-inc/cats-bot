import { randomUUID } from 'node:crypto';

import type { WorkItem, WorkItemKind, WorkItemState } from '../types.ts';

/** SPEC-001 FR-15 / FR-16: work items and the few transitions the core makes. */

export interface CreateWorkItemInput {
  kind: WorkItemKind;
  source: string;
  conversationId: string;
  prompt: string;
  coalesceKey?: string;
}

export function createWorkItem(input: CreateWorkItemInput, now: Date): WorkItem {
  const at = now.toISOString();
  return {
    id: `wi-${randomUUID().slice(0, 12)}`,
    kind: input.kind,
    source: input.source,
    conversationId: input.conversationId,
    prompt: input.prompt,
    createdAt: at,
    admittedAt: null,
    configRevision: null,
    state: 'queued',
    attempts: 0,
    ...(input.coalesceKey ? { coalesceKey: input.coalesceKey } : {}),
    updatedAt: at,
  };
}

export const TERMINAL_WORK_STATES: readonly WorkItemState[] = [
  'completed',
  'failed',
  'cancelled',
  'interrupted',
];

export function isTerminalWorkState(state: WorkItemState): boolean {
  return TERMINAL_WORK_STATES.includes(state);
}

export function transitionWorkItem(
  item: WorkItem,
  state: WorkItemState,
  now: Date,
  patch: Partial<Omit<WorkItem, 'id' | 'state' | 'updatedAt'>> = {},
): WorkItem {
  return { ...item, ...patch, state, updatedAt: now.toISOString() };
}

/** Owner messages go before every background item; otherwise arrival order (FR-16). */
export function compareWorkItems(a: WorkItem, b: WorkItem): number {
  const ownerA = a.kind === 'owner_message' ? 0 : 1;
  const ownerB = b.kind === 'owner_message' ? 0 : 1;
  if (ownerA !== ownerB) return ownerA - ownerB;
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}
