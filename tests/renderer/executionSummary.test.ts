import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ModelCatalog, ModelControl } from '../../src/core/types.ts';
import { acceptLanguage } from '../../src/renderer/localeStore.ts';
import { executionSummary } from '../../src/renderer/note/executionSummary.ts';

/** SPEC-003 FR-11: the note header face's model line, composed as Cats Desktop's audience chip composes a cat's tooltip. */

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

test('a bot on the provider default is named by the catalog default, as Cats Desktop\'s audience chip names a cat', () => {
  assert.equal(executionSummary('QQ', { provider: 'claude', model: null }, catalog), 'QQ · Claude-CLI · Opus 5.5 · Medium');
});

test('a chosen model and its chosen controls are named by their catalog labels, and nothing else', () => {
  assert.equal(executionSummary('QQ', {
    provider: 'claude', model: 'fable',
    modelSelection: { entryMode: 'explicit', entryId: 'fable', controls: { 'claude.reasoning_effort': 'xhigh' } },
  }, catalog), 'QQ · Claude-CLI · Fable 5.1 · xHigh');
  // Like the chip, a control the target does not choose is not named, and neither is an empty or false one.
  assert.equal(executionSummary('QQ', { provider: 'claude', model: 'fable' }, catalog), 'QQ · Claude-CLI · Fable 5.1');
  assert.equal(executionSummary('QQ', {
    provider: 'claude', model: 'opus',
    modelSelection: { entryMode: 'explicit', entryId: 'opus', controls: { 'claude.reasoning_effort': 'high', 'claude.fast': false, 'claude.note': '' } },
  }, catalog), 'QQ · Claude-CLI · Opus 5.5 · High');
  assert.equal(executionSummary('QQ', { provider: 'claude', model: 'claude-haiku-4-5-20251001' }, catalog), 'QQ · Claude-CLI · Haiku 4.5');
});

test('without a catalog the label falls back to the ids it has', () => {
  assert.equal(executionSummary('Mochi', { provider: 'codex', model: 'gpt-5.5-codex' }, null), 'Mochi · Codex-CLI · gpt-5.5-codex');
  assert.equal(executionSummary('Mochi', { provider: 'codex', model: null }, null), 'Mochi · Codex-CLI');
});

test('nothing in the label is translated', () => {
  acceptLanguage({ preference: 'zh-TW', locale: 'zh-TW' });
  try {
    assert.equal(executionSummary('QQ', {
      provider: 'claude', model: 'opus',
      modelSelection: { entryMode: 'explicit', entryId: 'opus', controls: { 'claude.reasoning_effort': 'xhigh' } },
    }, catalog), 'QQ · Claude-CLI · Opus 5.5 · xHigh');
  } finally {
    acceptLanguage({ preference: 'en', locale: 'en' });
  }
});
