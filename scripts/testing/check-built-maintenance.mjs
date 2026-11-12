#!/usr/bin/env node
/**
 * SPEC-014 FR-13: the built core checks and snapshots a state database inside the shipped
 * Electron, as a packaged bot does: `dist/`'s compiled modules start the compiled child
 * script, under a path with spaces and characters outside ASCII. CI runs this after the
 * build; the tests run the TypeScript sources instead.
 *
 * Usage: node scripts/testing/check-built-maintenance.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)));

if (process.argv[2] !== '--inside') {
  if (!existsSync(join(repository, 'dist', 'core', 'store', 'stateMaintenanceProcess.js'))) {
    console.error('dist/ holds no built core; run `npm run build` first.');
    process.exit(1);
  }
  const electron = createRequire(import.meta.url)('electron');
  const run = spawnSync(electron, [fileURLToPath(import.meta.url), '--inside'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
    timeout: 120_000,
  });
  process.exit(run.status ?? 1);
}

const load = (relative) => import(pathToFileURL(join(repository, relative)).href);
const { openBotStateStore } = await load('dist/core/store/stateStore.js');
const { botPathsFor, stateDatabaseFile } = await load('dist/core/store/paths.js');
const { checkStateDatabase, snapshots, takeSnapshot } = await load(
  'dist/core/store/stateMaintenance.js',
);

const scratch = mkdtempSync(join(tmpdir(), 'cats bot 檢查 '));
try {
  const paths = botPathsFor(scratch);
  const store = openBotStateStore({ file: stateDatabaseFile(paths), mode: 'writer' });
  store.saveConversation({ id: 'home', role: 'home', title: 'Direct message' });
  store.appendEntry('home', {
    at: new Date().toISOString(),
    kind: 'owner',
    origin: 'owner',
    text: '去公園散步',
  });
  store.close();
  const problems = await checkStateDatabase(paths).result;
  if (problems.length > 0) throw new Error(`the check found ${problems.join('; ')}`);
  const snapshot = await takeSnapshot(paths, new Date()).result;
  const copy = openBotStateStore({ file: snapshot.file, mode: 'reader' });
  const entries = copy.entries('home').length;
  copy.close();
  if (entries !== 1 || snapshots(paths).length !== 1)
    throw new Error(`the snapshot holds ${entries} entries`);
  console.log(
    `Inside Electron ${process.versions.electron}: the built core checked and snapshotted a database (${readdirSync(scratch).length} items).`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
