import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLI_PROVIDERS } from '../../src/core/providers/catalog.ts';
import { stepFacts, UPDATE_SUMMARY, updateFacts } from '../../src/renderer/settings/setup/setupFacts.ts';
import {
  canUpdate,
  changeFor,
  changeQueue,
  computerChecks,
  computerGroups,
  neededHelpers,
  neededPending,
  neededTickable,
  rowKind,
  shortClock,
  stemClass,
  updatableSteps,
  retryChange,
  updateNote,
  usersByProvider,
  type ComputerStep,
} from '../../src/renderer/settings/setup/setupLogic.ts';
import { translate } from '../../src/shared/language.ts';
import {
  SETUP_PROVIDER_IDS,
  UPDATABLE_HELPERS,
  type ComputerSetupState,
  type SetupHelperId,
} from '../../src/shared/providerSetup.ts';

/** SPEC-013: what the Agent CLIs tab and a cat bot's own tab decide, apart from React. */

const row = (id: SetupHelperId, status: string, extra: Partial<ComputerStep> = {}): ComputerStep => ({
  id, label: id, status, installed: status === 'ready', version: status === 'ready' ? '1.0.0' : null,
  manualSteps: [], warnings: [], restartRequired: false, optional: id === 'shell', planned: [], applied: [],
  script: null, applyCommand: `fake ${id} -Apply`,
  updateCommand: (UPDATABLE_HELPERS as readonly string[]).includes(id) ? `fake ${id} -Upgrade` : null, ...extra,
});
const computer = (platform: string, ...steps: ComputerStep[]): ComputerSetupState => ({ platform, checkedAt: null, steps, signIn: {} });

test('the shared provider list matches the catalog the shell installs from', () => {
  assert.deepEqual([...SETUP_PROVIDER_IDS], CLI_PROVIDERS.map((item) => item.id));
});

test('a row not checked yet and one whose check could not run are their own states (FR-3, FR-5)', () => {
  assert.equal(rowKind(row('claude', 'not_checked')), 'unchecked');
  assert.equal(rowKind(row('claude', 'check_failed')), 'checkFailed');
  assert.equal(rowKind(row('claude', 'auth_required', { installed: true })), 'ready', 'a provider waiting only for sign-in works');
  assert.equal(rowKind(row('node', 'auth_required', { installed: true })), 'needs', 'only a provider can wait for sign-in');
});

test('a working row whose helper has an update offers one; nothing else does (FR-8)', () => {
  assert.equal(canUpdate(row('claude', 'ready')), true);
  assert.equal(canUpdate(row('node', 'ready')), true);
  assert.equal(canUpdate(row('npm', 'ready')), false);
  assert.equal(canUpdate(row('shell', 'ready')), false);
  assert.equal(canUpdate(row('claude', 'changes_required')), false, 'it is installed first');
  assert.equal(canUpdate(row('claude', 'not_checked')), false, 'nothing is offered before a check');
  assert.equal(changeFor(row('claude', 'changes_required')), 'apply');
  assert.equal(changeFor(row('claude', 'ready')), 'upgrade');
  assert.equal(changeFor(row('npm', 'ready')), null);
  assert.equal(changeFor(row('claude', 'failed')), null);
});

test('ticked rows run top down, installs and updates alike (FR-7)', () => {
  const steps = [row('node', 'ready'), row('npm', 'changes_required'), row('codex', 'prerequisite_required'), row('claude', 'ready'), row('grok', 'changes_required')];
  assert.deepEqual(changeQueue(steps, new Set(['grok', 'node', 'codex', 'claude'])), ['node', 'claude', 'grok']);
  assert.deepEqual(updatableSteps(steps).map((step) => step.id), ['node', 'claude']);
});

test('rows group as the wizard groups them, with Node.js at the root of its stem (FR-2)', () => {
  const all = (['node', 'npm', 'codex', 'claude', 'antigravity', 'grok', 'muse', 'shell'] as const).map((id) => row(id, 'not_checked'));
  const groups = computerGroups(computer('win32', ...all));
  assert.deepEqual(groups.map((group) => [group.key, group.rows.map((step) => step.id)]), [
    ['node', ['node', 'npm', 'codex']],
    ['native', ['claude', 'antigravity', 'grok', 'muse']],
    ['optional', ['shell']],
  ]);
  assert.deepEqual(groups[0]!.rows.map((_step, index) => stemClass(groups[0]!, index)), ['is-dep-root', 'is-dep', 'is-dep is-dep-last']);
  assert.equal(stemClass(groups[1]!, 0), undefined);
  assert.deepEqual(computerGroups(computer('darwin', ...all.filter((step) => step.id !== 'shell'))).map((group) => group.key), ['node', 'native']);
  assert.equal(computerChecks(computer('win32', ...all)), 9, 'eight rows and Codex first-time setup');
  assert.equal(computerChecks(computer('darwin', ...all.slice(0, 7))), 7);
});

test('what the cat bots need comes from who uses which CLI; archived cat bots do not count (FR-6)', () => {
  const users = usersByProvider([
    { name: 'Mochi', provider: 'codex', state: 'running' },
    { name: 'Tora', provider: 'codex', state: 'stopped' },
    { name: 'Kuro', provider: 'grok', state: 'archived' },
    { name: 'Hana', provider: 'claude', state: 'failed' },
    { name: 'Old', provider: null, state: 'missing' },
  ]);
  assert.deepEqual([...users], [['codex', ['Mochi', 'Tora']], ['claude', ['Hana']]]);
  const needed = neededHelpers(users);
  assert.deepEqual([...needed].sort(), ['claude', 'codex', 'node', 'npm']);
  const steps = [row('node', 'ready'), row('npm', 'changes_required'), row('codex', 'prerequisite_required'), row('claude', 'changes_required'), row('grok', 'changes_required'), row('shell', 'changes_required')];
  assert.deepEqual(neededPending(steps, needed).map((step) => step.id), ['npm', 'codex', 'claude']);
  assert.deepEqual(neededTickable(steps, needed).map((step) => step.id), ['npm', 'claude'], 'Grok is offered, not required');
  assert.deepEqual([...neededHelpers(new Map([['muse', ['Nori']]]))], ['muse'], 'no Node.js without Codex');
});

test('an update says what it found, or that it did not finish (FR-9)', () => {
  assert.equal(updateNote(row('claude', 'ready')), null);
  assert.deepEqual(updateNote(row('claude', 'ready', { lastUpdate: { from: '2.0.14', to: '2.0.20', outcome: 'updated' } })),
    { text: 'Updated {from} → {to}', values: { from: '2.0.14', to: '2.0.20' }, tone: 'ok' });
  assert.equal(updateNote(row('claude', 'ready', { lastUpdate: { from: null, to: '2.0.20', outcome: 'updated' } }))?.text, 'Updated to {to}');
  assert.equal(updateNote(row('claude', 'ready', { lastUpdate: { from: '2.0.20', to: '2.0.20', outcome: 'current' } }))?.text, 'Already the newest');
  assert.equal(updateNote(row('node', 'ready', { lastUpdate: { from: '22', to: '22', outcome: 'declined' } }))?.tone, 'danger');
  assert.match(updateNote(row('node', 'ready', { lastUpdate: { from: '22', to: '22', outcome: 'failed' } }))!.text, /still works/u);
  assert.match(updateNote(row('node', 'ready', { lastUpdate: { from: '22', to: '22', outcome: 'restart' } }))!.text, /after a restart/u);
  assert.equal(shortClock('2026-11-11T09:05:07.000Z').length, 5);
});

test('an update is worded for what it really runs, on each operating system (FR-8)', () => {
  const node = updateFacts(row('node', 'ready'), 'node', 'win32');
  assert.equal(node.summary, UPDATE_SUMMARY);
  assert.deepEqual(node.tags.map((tag) => tag.text), ['Needs administrator rights', 'Downloads and installs', "Accepts winget's agreements for you"]);
  assert.equal(node.manual, 'winget upgrade --id OpenJS.NodeJS.LTS -e');
  assert.equal(updateFacts(row('node', 'ready'), 'node', 'darwin').manual, 'nvm install --lts');
  const codex = updateFacts(row('codex', 'ready'), 'codex', 'linux');
  assert.deepEqual(codex.tags.map((tag) => tag.text), ['Downloads from npm', 'Also updates npm to its newest release']);
  assert.equal(codex.manual, 'npm install -g @openai/codex@latest');
  const claude = updateFacts(row('claude', 'ready', { planned: ['remove_legacy_npm_claude_shim'] }), 'claude', 'win32');
  assert.equal(claude.manual, 'irm https://claude.ai/install.ps1 | iex');
  assert.ok(!claude.tags.some((tag) => tag.danger), 'an update removes nothing');
  // A provider row in the Agent CLIs tab is its own id, and words its install like a bot's chain does.
  assert.equal(stepFacts(row('codex', 'changes_required'), 'codex', 'win32').manual, 'npm install -g @openai/codex');
  assert.equal(stepFacts(row('grok', 'changes_required'), 'grok', 'win32').manual, 'irm https://x.ai/cli/install.ps1 | iex');
});

test('Try again installs a row its update left broken, and repeats anything else', () => {
  assert.equal(retryChange(row('claude', 'failed', { installed: false }), 'upgrade'), 'apply');
  assert.equal(retryChange(row('claude', 'failed', { installed: true }), 'upgrade'), 'upgrade');
  assert.equal(retryChange(row('claude', 'failed', { installed: false }), 'apply'), 'apply');
});

test('every new line of the Agent CLIs tab reads in Traditional Chinese', () => {
  for (const text of [
    'Agent CLIs', 'Installed through Node.js', 'With their own installer', 'Optional, and fine to leave for later',
    'Updated {from} → {to}', 'Updated to {to}', 'Already the newest',
    'The update did not finish, and the version you had still works. The log below says why.',
    'Installed. It finishes after a restart; the version you had works until then.',
    UPDATE_SUMMARY, 'Also updates npm to its newest release',
  ]) {
    assert.notEqual(translate('zh-TW', text), text, text);
  }
});
