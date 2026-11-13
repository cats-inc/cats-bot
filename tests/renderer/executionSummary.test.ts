import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ModelCatalog, ModelControl } from '../../src/core/types.ts';
import { acceptLanguage } from '../../src/renderer/localeStore.ts';
import { executionSummary } from '../../src/renderer/note/executionSummary.ts';

/** The note header's (i): provider, model and effort, named as the model catalog names them. */

const effort = (defaultValue: string): ModelControl => ({
  key: 'claude.reasoning_effort',
  label: 'Reasoning effort',
  kind: 'enum',
  values: ['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({
    value,
    label: `${value === 'xhigh' ? 'xHigh' : value[0]!.toUpperCase() + value.slice(1)}${value === defaultValue ? ' (default)' : ''}`,
  })),
});

const catalog: ModelCatalog = {
  provider: 'claude',
  defaultModel: 'opus',
  source: 'runtime',
  models: [
    { id: 'opus', label: 'Opus 5.5', default: true, controls: [effort('medium')] },
    { id: 'fable', label: 'Fable 5.1', default: false, controls: [effort('high')] },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', default: false },
  ],
  defaultSelection: { entryMode: 'explicit', entryId: 'opus', controls: { 'claude.reasoning_effort': 'medium' } },
};

test('a bot on the provider default reads the catalog default, without the "(default)" mark', () => {
  assert.equal(executionSummary({ provider: 'claude', model: null }, catalog, 'Claude'), 'Claude · Opus 5.5 · Medium effort');
});

test('a chosen model and effort are named by their catalog labels', () => {
  assert.equal(executionSummary({
    provider: 'claude', model: 'fable',
    modelSelection: { entryMode: 'explicit', entryId: 'fable', controls: { 'claude.reasoning_effort': 'xhigh' } },
  }, catalog, 'Claude'), 'Claude · Fable 5.1 · xHigh effort');
  // The model's own default effort when only the model was chosen.
  assert.equal(executionSummary({ provider: 'claude', model: 'fable' }, catalog, 'Claude'), 'Claude · Fable 5.1 · High effort');
  // A model without an effort control has no effort part.
  assert.equal(executionSummary({ provider: 'claude', model: 'claude-haiku-4-5-20251001' }, catalog, 'Claude'), 'Claude · Haiku 4.5');
});

test('without a catalog the summary falls back to the ids it has', () => {
  assert.equal(executionSummary({ provider: 'codex', model: 'gpt-5.5-codex' }, null, null), 'codex · gpt-5.5-codex');
  assert.equal(executionSummary({ provider: 'codex', model: null }, null, 'Codex'), 'Codex');
});

test('the effort part is translated', () => {
  acceptLanguage({ preference: 'zh-TW', locale: 'zh-TW' });
  try {
    assert.equal(executionSummary({ provider: 'claude', model: null }, catalog, 'Claude'), 'Claude · Opus 5.5 · 推理強度 Medium');
  } finally {
    acceptLanguage({ preference: 'en', locale: 'en' });
  }
});
