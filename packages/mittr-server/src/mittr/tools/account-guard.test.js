import assert from 'node:assert/strict';
import test from 'node:test';

import { keyOf } from '../account-store.js';
import { pinAccount, sessionKeyOf } from './account-guard.js';
import { MittrToolError } from './registry.js';

const accountChanged = (error) => error instanceof MittrToolError && error.statusCode === 409 && error.message === 'The Mittr account changed';

const accounts = (start) => {
  let active = start;
  return { activeAccountKey: () => active, switchTo: (key) => { active = key; } };
};

test('a pin holds while the account, the session and the engine stay the same', () => {
  const { activeAccountKey } = accounts('acct-a');
  const check = pinAccount({ activeAccountKey, engineOnActiveHome: () => true });
  check();
  check('acct-a');
});

test('a switched account, another session\'s key or an engine still on the old home ends the pin', () => {
  const people = accounts('acct-a');
  let engineMoved = true;
  const check = pinAccount({ activeAccountKey: people.activeAccountKey, engineOnActiveHome: () => engineMoved });
  assert.throws(() => check('acct-b'), accountChanged);
  engineMoved = false;
  assert.throws(() => check(), accountChanged);
  engineMoved = true;
  people.switchTo('acct-b');
  assert.throws(() => check(), accountChanged);
});

test('a speech pin ignores the engine when asked to', () => {
  const people = accounts('acct-a');
  const check = pinAccount({ activeAccountKey: people.activeAccountKey, engineOnActiveHome: () => true });
  check();
  people.switchTo('acct-b');
  assert.throws(() => check(), accountChanged);
});

test('a pin made without an engine check is refused when it is made', () => {
  const { activeAccountKey } = accounts('acct-a');
  assert.throws(() => pinAccount({ activeAccountKey }), /engineOnActiveHome/);
});

test('a session\'s key comes from its user id', () => {
  assert.equal(sessionKeyOf({ subject: { userId: 'u1' } }), keyOf('u1'));
  assert.equal(sessionKeyOf({ subject: { userId: '' } }), null);
  assert.equal(sessionKeyOf(null), null);
});
