import assert from 'node:assert/strict';
import test from 'node:test';

import { HEARD_TTL_MS, createVoiceConversation } from './conversation.js';

const ids = () => {
  let next = 0;
  return () => `id-${(next += 1)}`;
};

test('one live conversation: a second start ends the first and tells the listeners', () => {
  const conversation = createVoiceConversation({ randomId: ids() });
  const ended = [];
  conversation.onEnd((id) => ended.push(id));
  const first = conversation.start();
  conversation.setPendingHost('a.test');
  conversation.allowChrome();
  const second = conversation.start();
  assert.notEqual(first, second);
  assert.deepEqual(ended, [first]);
  assert.equal(conversation.current(), second);
  assert.equal(conversation.chromeAllowed(), false);
  assert.equal(conversation.pendingHost(), null);
  assert.equal(conversation.end(first), false);
  assert.equal(conversation.end(second), true);
  assert.equal(conversation.current(), null);
  assert.deepEqual(ended, [first, second]);
  conversation.endAll();
  assert.deepEqual(ended, [first, second]);
});

test('a receipt is used once, within 120 seconds, for the text it was given', () => {
  assert.equal(HEARD_TTL_MS, 120_000);
  let now = 1_000;
  const conversation = createVoiceConversation({ now: () => now, randomId: ids() });
  const id = conversation.start();
  const heard = conversation.hear(id, '  open the shop  ');
  assert.equal(conversation.take(id, heard, 'something else'), false);
  const again = conversation.hear(id, 'open the shop');
  assert.equal(conversation.take(id, again, ' open the shop '), true);
  assert.equal(conversation.take(id, again, 'open the shop'), false);

  const late = conversation.hear(id, 'later');
  now += 120_001;
  assert.equal(conversation.take(id, late, 'later'), false);

  const other = conversation.hear(id, 'moved');
  const next = conversation.start();
  assert.equal(conversation.take(next, other, 'moved'), false);
  assert.equal(conversation.hear('not-live', 'x'), null);
});

test('the pending host and the Chrome allow belong to the live conversation', () => {
  const conversation = createVoiceConversation({ randomId: ids() });
  conversation.setPendingHost('a.test');
  assert.equal(conversation.pendingHost(), null);
  conversation.start();
  conversation.setPendingHost('a.test');
  assert.equal(conversation.pendingHost(), 'a.test');
  conversation.allowChrome();
  assert.equal(conversation.chromeAllowed(), true);
  assert.equal(conversation.pendingHost(), null);
  conversation.endAll();
  assert.equal(conversation.chromeAllowed(), false);
});
