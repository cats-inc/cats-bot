import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readPackagedModelCatalog } from '../../src/core/providers/catalog.ts';
import type { ModelCatalog } from '../../src/core/types.ts';
import { controlChoices, modelControls, modelOptions, selectedModel } from '../../src/renderer/settings/settingsLogic.ts';
import { PROVIDER_VENDORS, stepFacts } from '../../src/renderer/settings/setup/setupFacts.ts';
import {
  addLogEntry,
  checksToRun,
  elapsedLabel,
  liveRow,
  logText,
  logTotals,
  PERSONA_PRESETS,
  pendingSteps,
  queueOf,
  requiredPending,
  requiredTickable,
  retryQueue,
  rowKind,
  runFacts,
  runFailed,
  stoppedStep,
} from '../../src/renderer/settings/setup/setupLogic.ts';
import { botPersonaProblem } from '../../src/shared/botText.ts';
import { translate, zhTW } from '../../src/shared/language.ts';
import type { ProviderSetupState, SetupLogEntry, SetupStep, SetupStepId } from '../../src/shared/providerSetup.ts';
import { canCreateFromSetup } from '../../src/shared/providerSetup.ts';

const step = (id: SetupStepId, status: string, extra: Partial<SetupStep> = {}): SetupStep => ({
  id, label: id, status, installed: status === 'ready', version: null, manualSteps: [], warnings: [], restartRequired: false,
  optional: id === 'shell', planned: [], applied: [], script: null, applyCommand: null, ...extra,
});
const state = (...steps: SetupStep[]): ProviderSetupState => ({
  provider: 'codex', steps, canFinish: false, signIn: 'unknown', signInCommand: 'codex login',
});

test('Codex initialization advice never disables Create once installation is complete', () => {
  assert.equal(canCreateFromSetup(null), false);
  for (const status of ['ready', 'required', 'unavailable'] as const) {
    const checked = { ...state(step('provider', 'ready')), codexInitialization: { status } };
    assert.equal(canCreateFromSetup(checked), false, 'missing prerequisites still block creation');
    assert.equal(canCreateFromSetup({ ...checked, canFinish: true }), true, status);
  }
});

test('each status maps to one row state (SPEC-010 FR-8)', () => {
  assert.equal(rowKind(step('node', 'ready')), 'ready');
  assert.equal(rowKind(step('provider', 'auth_required', { installed: true })), 'ready', 'installed and waiting only for sign-in');
  assert.equal(rowKind(step('provider', 'auth_required', { installed: false })), 'needs');
  assert.equal(rowKind(step('node', 'changes_required')), 'needs');
  assert.equal(rowKind(step('provider', 'not_installed')), 'needs');
  assert.equal(rowKind(step('npm', 'prerequisite_required')), 'waiting');
  assert.equal(rowKind(step('node', 'failed')), 'failed');
  assert.equal(rowKind(step('node', 'elevation_required')), 'declined');
  assert.equal(rowKind(step('node', 'restart_required')), 'restart');
  assert.equal(rowKind(step('node', 'relaunch_required')), 'restart');
  assert.equal(rowKind(step('node', 'ready', { restartRequired: true })), 'restart', 'ready but asking for a restart is not done');
  assert.equal(rowKind(step('node', 'something_new')), 'needs', 'an unknown status is not taken as ready');
  assert.equal(rowKind(step('node', 'changes_required', { systemRestartRequired: true })), 'restart', 'a missing Node keeps the explicit Windows reboot advice');
  assert.equal(rowKind(step('node', 'ready', { systemRestartRequired: true })), 'ready', 'a usable Node can continue while the reboot advice remains visible');
  assert.equal(rowKind(step('node', 'failed', { systemRestartRequired: true })), 'failed', 'reboot advice cannot hide a real check failure');
});

test('the shortcut, the queue and what is left leave optional and waiting rows alone (FR-9, FR-11)', () => {
  const current = state(step('node', 'ready'), step('npm', 'changes_required'), step('provider', 'changes_required'), step('shell', 'changes_required'));
  assert.deepEqual(requiredTickable(current).map((item) => item.id), ['npm', 'provider']);
  assert.deepEqual(requiredPending(current).map((item) => item.id), ['npm', 'provider']);
  assert.deepEqual(queueOf(current, new Set<SetupStepId>(['shell', 'provider', 'npm'])), ['npm', 'provider', 'shell'], 'top down, whatever order they were ticked');
  assert.deepEqual(queueOf(current, new Set<SetupStepId>(['node'])), [], 'a ready row never runs');
  const waiting = state(step('node', 'changes_required'), step('npm', 'prerequisite_required'), step('provider', 'prerequisite_required'));
  assert.deepEqual(requiredTickable(waiting).map((item) => item.id), ['node']);
  assert.deepEqual(queueOf(waiting, new Set<SetupStepId>(['npm', 'node'])), ['node'], 'a waiting row cannot have been ticked into the queue');
  assert.deepEqual(requiredPending(waiting).map((item) => item.id), ['node', 'npm', 'provider']);
  assert.deepEqual(queueOf(null, new Set<SetupStepId>(['node'])), []);
  assert.deepEqual(queueOf(state(step('node', 'failed')), new Set<SetupStepId>(['node'])), [], 'a failed row has no tick box to undo the tick');
});

test('the row that stopped the queue is the one the page speaks to', () => {
  assert.equal(stoppedStep(state(step('node', 'ready'), step('npm', 'changes_required'))), null);
  assert.equal(stoppedStep(state(step('node', 'elevation_required'), step('npm', 'prerequisite_required')))?.id, 'node');
  assert.equal(stoppedStep(state(step('node', 'ready'), step('npm', 'relaunch_required')))?.id, 'npm');
  assert.equal(stoppedStep(null), null);
});

test('only a row the owner already ran can be tried again (FR-9)', () => {
  const ran = new Set<SetupStepId>(['node']);
  const none = new Set<SetupStepId>();
  assert.deepEqual(retryQueue(step('node', 'elevation_required'), ran, ['npm', 'node']), ['node', 'npm'], 'it goes first, then what is still ticked');
  assert.deepEqual(retryQueue(step('node', 'failed'), ran, []), ['node']);
  assert.deepEqual(retryQueue(step('node', 'failed'), none, ['npm']), [], 'a row that failed a check was never ticked');
  assert.deepEqual(retryQueue(step('node', 'elevation_required'), none, []), []);
  assert.deepEqual(retryQueue(step('node', 'relaunch_required'), ran, []), [], 'a restart is not a retry');
  assert.deepEqual(retryQueue(null, ran, ['npm']), []);
});

test('rows before the check follow the shell\'s order, and the hint counts them (FR-3, FR-8)', () => {
  assert.deepEqual(pendingSteps('codex', 'Codex', 'win32').map((item) => item.id), ['node', 'npm', 'provider', 'shell']);
  assert.deepEqual(pendingSteps('codex', 'Codex', 'darwin').map((item) => item.id), ['node', 'npm', 'provider']);
  assert.deepEqual(pendingSteps('grok', 'Grok', 'win32').map((item) => [item.id, item.helper]), [['provider', 'grok']]);
  assert.equal(checksToRun('codex', 'win32'), 5);
  assert.equal(checksToRun('codex', 'linux'), 3);
  assert.equal(checksToRun('muse', 'win32'), 1);
});

const entry = (run: number, phase: 'start' | 'end', extra: Partial<SetupLogEntry> = {}): SetupLogEntry => ({
  run, phase, at: '2026-11-04T10:00:00.000Z', kind: 'check', helper: 'node', file: 'Install-Node.ps1', command: 'powershell.exe x', ...extra,
});

test('a run\'s two entries become one line of the log, keeping when it started (FR-14)', () => {
  let runs = addLogEntry([], entry(1, 'start'));
  assert.equal(runs[0]!.ended, false);
  runs = addLogEntry(runs, entry(1, 'end', { at: '2026-11-04T10:00:05.000Z', status: 'ready', version: '24.0.0', durationMs: 1200 }));
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.at, '2026-11-04T10:00:00.000Z');
  assert.equal(runs[0]!.ended, true);
  assert.deepEqual(runFacts(runs[0]!), ['status: ready, version: 24.0.0', 'took 1.2 s']);
  runs = addLogEntry(runs, entry(2, 'end', { kind: 'change', file: 'x.ps1', status: 'ready', planned: ['a'], applied: ['b'], warnings: ['c'], manualSteps: ['d'], error: 'e' }));
  assert.deepEqual(runFacts(runs[1]!), ['status: ready', 'planned: a', 'applied: b', 'warning: c', 'next: d', 'error: e']);
  assert.match(logText(runs), /Install-Node\.ps1\n> powershell\.exe x\nstatus: ready/u);
});

test('only what really changed counts as a change: a declined prompt does not (FR-14, FR-18)', () => {
  const finished = (extra: Partial<SetupLogEntry>) => addLogEntry([], entry(1, 'end', { kind: 'change', ...extra }))[0]!;
  // Install-Node answers a declined UAC prompt with its check's own status.
  const declined = finished({ status: 'changes_required', warnings: ['Administrator elevation was cancelled or failed.'] });
  assert.equal(runFailed(declined), true);
  assert.equal(runFailed(finished({ status: 'failed' })), true);
  assert.equal(runFailed(finished({ error: 'unreadable' })), true);
  assert.equal(runFailed(finished({ status: 'ready' })), false);
  assert.equal(runFailed(finished({ status: 'relaunch_required', applied: ['installed'] })), false);
  const totals = logTotals([
    finished({ status: 'ready', run: 1 }),
    { ...declined, run: 2 },
    addLogEntry([], entry(3, 'end', { status: 'changes_required' }))[0]!,
    addLogEntry([], entry(4, 'start', { kind: 'change' }))[0]!,
  ]);
  assert.deepEqual(totals, { checks: 1, changes: 1 }, 'a run still going counts as neither');
});

test('a row during a check follows the log, and only this check\'s runs', () => {
  const runs = [
    { ...addLogEntry([], entry(1, 'end', { status: 'ready' }))[0]! },
    { ...addLogEntry([], entry(2, 'start', { helper: 'npm' }))[0]! },
    { ...addLogEntry([], entry(3, 'end', { helper: 'shell', status: 'changes_required' }))[0]! },
    { ...addLogEntry([], entry(4, 'end', { helper: 'claude', status: 'auth_required' }))[0]! },
  ];
  assert.equal(liveRow(runs, 0, 'node'), 'ready');
  assert.equal(liveRow(runs, 0, 'npm'), 'checking');
  assert.equal(liveRow(runs, 0, 'shell'), 'needs');
  assert.equal(liveRow(runs, 0, 'claude'), 'ready');
  assert.equal(liveRow(runs, 0, 'codex'), 'pending');
  assert.equal(liveRow(runs, 1, 'node'), 'pending', 'a run before this check says nothing about it');
  assert.equal(elapsedLabel(65_400), '01:05');
});

test('presets are five, follow the rule themselves and are translated (FR-5, FR-19)', () => {
  assert.equal(PERSONA_PRESETS.length, 5);
  assert.deepEqual(PERSONA_PRESETS.map((preset) => preset.label), ['Curious', 'Steady', 'Playful', 'Gentle', 'Blunt']);
  for (const preset of PERSONA_PRESETS) {
    assert.equal(botPersonaProblem(preset.text), null, preset.label);
    assert.ok(Object.hasOwn(zhTW, preset.label), preset.label);
    assert.ok(Object.hasOwn(zhTW, preset.text), preset.text);
    assert.equal(botPersonaProblem(translate('zh-TW', preset.text)), null, preset.label);
    assert.notEqual(translate('zh-TW', preset.text), preset.text);
  }
  assert.match(translate('zh-TW', PERSONA_PRESETS[0]!.text), /^你是一隻好奇的貓咪/u);
});

const SCRIPT = { file: 'x', sha256: null, source: null };

test('facts name what each script really does, by operating system (FR-10)', () => {
  const tags = (id: SetupStepId, provider: string, platform: string, extra: Partial<SetupStep> = {}) =>
    stepFacts(step(id, 'changes_required', { script: SCRIPT, ...extra }), provider, platform).tags.map((tag) => tag.text);
  assert.ok(tags('node', 'codex', 'win32').includes('Needs administrator rights'));
  assert.ok(tags('node', 'codex', 'win32').includes("Accepts winget's agreements for you"));
  assert.ok(!tags('node', 'codex', 'linux').includes('Needs administrator rights'), 'nvm needs none');
  assert.ok(tags('node', 'codex', 'darwin').includes('Changes your shell profile'));
  assert.ok(tags('npm', 'codex', 'win32').includes('Changes your user PATH'));
  assert.ok(tags('npm', 'codex', 'linux').includes('Changes your shell profile'));
  assert.ok(tags('shell', 'codex', 'win32').includes('Changes your PowerShell execution policy'));
  const grok = stepFacts(step('provider', 'not_installed'), 'grok', 'win32');
  assert.equal(grok.tags[0]!.values!.script, 'x.ai/cli/install.ps1');
  assert.equal(grok.manual, 'irm https://x.ai/cli/install.ps1 | iex');
  assert.equal(grok.summaryValues!.vendor, 'xAI');
  const mac = stepFacts(step('provider', 'not_installed'), 'muse', 'darwin');
  assert.equal(mac.tags[0]!.values!.script, 'dev.meta.ai/install.sh');
  assert.equal(mac.manual, 'curl -fsSL https://dev.meta.ai/install.sh | bash');
  assert.equal(stepFacts(step('provider', 'not_installed'), 'codex', 'win32').manual, 'npm install -g @openai/codex');
});

test('removing something is said plainly, from the helper\'s own plan', () => {
  const shimOnly = stepFacts(step('provider', 'changes_required', { planned: ['remove_legacy_npm_claude_shim'] }), 'claude', 'win32');
  assert.ok(shimOnly.tags.some((tag) => tag.danger && tag.text === 'Removes the npm version of Claude Code'));
  assert.equal(shimOnly.manual, 'npm uninstall -g @anthropic-ai/claude-code');
  const both = stepFacts(step('provider', 'changes_required', { planned: ['remove_legacy_npm_claude_shim', 'install_claude_code_native'] }), 'claude', 'win32');
  assert.ok(both.tags.some((tag) => tag.danger));
  assert.ok(both.tags.some((tag) => tag.values?.script === 'claude.ai/install.ps1'));
  const clean = stepFacts(step('provider', 'not_installed', { planned: ['install_claude_code_native'] }), 'claude', 'win32');
  assert.ok(!clean.tags.some((tag) => tag.danger));
});

test('every fact a row can show has its Traditional Chinese', () => {
  const missing = new Set<string>();
  for (const platform of ['win32', 'darwin', 'linux']) {
    for (const provider of Object.keys(PROVIDER_VENDORS)) {
      for (const id of ['node', 'npm', 'shell', 'provider'] as const) {
        for (const planned of [[], ['remove_legacy_npm_claude_shim'], ['remove_legacy_npm_claude_shim', 'install_claude_code_native']]) {
          const facts = stepFacts(step(id, 'changes_required', { planned }), provider, platform);
          for (const text of [facts.summary, ...facts.tags.map((tag) => tag.text)]) {
            if (!Object.hasOwn(zhTW, text)) missing.add(text);
          }
        }
      }
    }
  }
  assert.deepEqual([...missing], []);
});

test('the model field follows the catalog, as Cats Chat does (FR-16)', () => {
  const claude = readPackagedModelCatalog('claude');
  assert.equal(modelOptions(claude).find((option) => option.value === 'opus')?.text, 'Opus 5.5 (default)');
  assert.equal(modelOptions(claude).find((option) => option.value === 'sonnet')?.text, 'Sonnet 5.5', 'only the default is marked');
  const [effort] = modelControls(claude, 'opus');
  assert.equal(effort!.label, 'Reasoning effort');
  assert.equal(Object.hasOwn(zhTW, 'Reasoning effort'), false, 'catalog text is shown as the catalog wrote it');
  assert.equal(controlChoices(claude, 'opus', effort!).find((choice) => choice.value === 'medium')?.label, 'Medium (default)');
  assert.equal(controlChoices(claude, 'opus', effort!).find((choice) => choice.value === 'high')?.label, 'High');
  assert.deepEqual(modelControls(claude, 'claude-haiku-4-5-20251001'), [], 'a model with no controls shows none');
  assert.equal(selectedModel(claude, 'opus')?.controls?.[effort!.key], 'medium');
});

test('with no default in the catalog the first value starts, and a request-scoped control is no setting', () => {
  const grok = readPackagedModelCatalog('grok');
  const [effort] = modelControls(grok, grok.models[0]!.id);
  assert.equal(selectedModel(grok, grok.models[0]!.id)?.controls?.[effort!.key], 'xhigh', 'the rule the owner chose');
  assert.ok(controlChoices(grok, grok.models[0]!.id, effort!).every((choice) => !choice.label.includes('(default)')), 'nothing is invented');
  const catalog: ModelCatalog = {
    provider: 'x', defaultModel: null, source: 'packaged',
    models: [{ id: 'm', label: 'M', default: false, controls: [
      { key: 'a', label: 'A', kind: 'enum', scope: 'both', values: [{ value: 1, label: 'one' }] },
      { key: 'b', label: 'B', kind: 'enum', scope: 'request', values: [{ value: 2, label: 'two' }] },
      { key: 'c', label: 'C', kind: 'enum', scope: 'session_default', values: [{ value: 3, label: 'three' }] },
    ] }],
  } as never;
  assert.deepEqual(modelControls(catalog, 'm').map((control) => control.key), ['a', 'c']);
});
