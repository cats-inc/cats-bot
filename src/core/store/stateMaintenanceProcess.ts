import {
  checkDatabaseFile,
  isDamagedDatabaseError,
  snapshotDatabaseFile,
} from './stateDatabase.ts';

/**
 * SPEC-014 FR-13: the check or the snapshot `stateMaintenance.ts` asks for, in a process of
 * its own, so that the core goes on meanwhile and can end it at once. It replies once over
 * the IPC channel and exits.
 */

const request = JSON.parse(process.argv[2] ?? '{}') as {
  task: 'check' | 'snapshot';
  file: string;
  target?: string;
};
let reply: unknown;
try {
  const value =
    request.task === 'check'
      ? checkDatabaseFile(request.file)
      : (snapshotDatabaseFile(request.file, request.target!), null);
  reply = { ok: true, value };
} catch (error) {
  reply = {
    ok: false,
    message: error instanceof Error ? error.message : String(error),
    damaged: isDamagedDatabaseError(error),
  };
}
process.send!(reply, () => process.disconnect());
