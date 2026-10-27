import type { WorkItem } from '../types.ts';
import { compareWorkItems } from './workItems.ts';

/**
 * SPEC-001 FR-16: a bot-wide serialized queue. Owner messages are admitted
 * before background work; a running background item is never preempted.
 */
export class WorkQueue {
  private readonly items: WorkItem[] = [];

  enqueue(item: WorkItem): void {
    if (this.items.some((queued) => queued.id === item.id)) return;
    this.items.push(item);
    this.items.sort(compareWorkItems);
  }

  take(): WorkItem | undefined {
    return this.items.shift();
  }

  peek(): WorkItem | undefined {
    return this.items[0];
  }

  remove(id: string): WorkItem | undefined {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) return undefined;
    return this.items.splice(index, 1)[0];
  }

  findByCoalesceKey(key: string): WorkItem | undefined {
    return this.items.find((item) => item.coalesceKey === key);
  }

  list(): WorkItem[] {
    return [...this.items];
  }

  get size(): number {
    return this.items.length;
  }
}
