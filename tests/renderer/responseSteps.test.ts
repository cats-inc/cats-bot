import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ConversationBlock } from '@cats-inc/platform-ui-web/contracts';
import { acceptLanguage } from '../../src/renderer/localeStore.ts';
import { foldedStepCount, isLiveReply, stepsLinkLabel } from '../../src/renderer/note/responseSteps.ts';

/** SPEC-003 FR-12: a finished reply folds its tool steps behind a link; text and failed steps always show. */

const block = (index: number, kind: ConversationBlock['kind'], status: ConversationBlock['status'] = 'complete'): ConversationBlock => ({
  id: `b${index}`, index, kind, status, title: null, text: '', toolName: kind === 'tool' ? 'Bash' : null, toolId: null,
});

test('the folded steps are the tool and progress blocks that did not fail', () => {
  assert.equal(foldedStepCount({ blocks: [block(0, 'text')] }), 0, 'a plain reply has no link');
  assert.equal(foldedStepCount({ blocks: [block(0, 'tool'), block(1, 'status'), block(2, 'tool', 'error'), block(3, 'text')] }), 2,
    'a failed step is always shown, so it is not folded');
});

test('only a sealed reply is finished', () => {
  assert.equal(isLiveReply({ phase: 'waiting' }), true);
  assert.equal(isLiveReply({ phase: 'streaming' }), true);
  assert.equal(isLiveReply({ phase: 'sealed' }), false);
});

test('the link names how many steps it opens, and how to fold them again', () => {
  assert.equal(stepsLinkLabel(1, false), '1 step');
  assert.equal(stepsLinkLabel(3, false), '3 steps');
  assert.equal(stepsLinkLabel(3, true), 'Hide steps');
  acceptLanguage({ preference: 'zh-TW', locale: 'zh-TW' });
  try {
    assert.equal(stepsLinkLabel(3, false), '3 個步驟');
    assert.equal(stepsLinkLabel(3, true), '收起步驟');
  } finally {
    acceptLanguage({ preference: 'en', locale: 'en' });
  }
});
