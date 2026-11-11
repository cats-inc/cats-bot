import { parentPort, workerData } from 'node:worker_threads';
import { checkDatabaseFile, snapshotDatabaseFile } from './stateDatabase.ts';

/**
 * SPEC-014 FR-13: the check or the snapshot `stateMaintenance.ts` asks for, on a connection
 * of this thread's own, so that the core's thread goes on meanwhile.
 */

const request = workerData as { task: 'check' | 'snapshot'; file: string; target?: string };
try {
  const value =
    request.task === 'check'
      ? checkDatabaseFile(request.file)
      : (snapshotDatabaseFile(request.file, request.target!), null);
  parentPort!.postMessage({ ok: true, value });
} catch (error) {
  parentPort!.postMessage({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
    code: (error as { code?: unknown } | null)?.code,
  });
}
