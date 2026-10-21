import assert from 'node:assert/strict';
import test from 'node:test';

import { isPlainObject, isRecord } from './values.js';

test('isRecord accepts objects and refuses null, arrays and primitives', () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord(new Date()), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord(undefined), false);
  assert.equal(isRecord('text'), false);
  assert.equal(isRecord(3), false);
});

test('isPlainObject accepts literal and null-prototype objects only', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(JSON.parse('{"a":1}')), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject(new Date()), false);
  assert.equal(isPlainObject(new Map()), false);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject(undefined), false);
  assert.equal(isPlainObject('text'), false);
});
