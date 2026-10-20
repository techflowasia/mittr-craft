import assert from 'node:assert/strict';
import test from 'node:test';

import { mintLocalToken } from './local-token.js';

const TOKEN = /^mc_local_[0-9a-f]{64}$/;

test('each key is new, in the mc_local_ form', () => {
  const first = mintLocalToken();
  const second = mintLocalToken();
  assert.match(first, TOKEN);
  assert.match(second, TOKEN);
  assert.notEqual(first, second);
});
