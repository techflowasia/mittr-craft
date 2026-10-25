import assert from 'node:assert/strict';
import test from 'node:test';

import { leakReport, passed } from './prove-engine-child-env.mjs';

const VALUES = { ACME_TOKEN: 'acme-value-1', ACME_PASSWORD: 'acme-value-2' };

test('a leak is a secret name set in the dump or a secret value anywhere in it', () => {
  const text = 'HOME=/tmp/p4.x\nACME_TOKEN=acme-value-1\nOTHER=has acme-value-2 inside\nNOT_ACME_PASSWORD=x\n';
  assert.deepEqual(leakReport(text, { names: Object.keys(VALUES), values: VALUES }), { leakedNames: ['ACME_TOKEN'], leakedValues: ['ACME_TOKEN', 'ACME_PASSWORD'] });
  assert.deepEqual(leakReport('HOME=/tmp/p4.x\n', { names: Object.keys(VALUES), values: VALUES }), { leakedNames: [], leakedValues: [] });
});

const clean = {
  shell: { ran: true, leakedNames: [], leakedValues: [], engineStatus: '401', toolsCallbackStatus: '401' },
  terminal: { ran: true, leakedNames: [], leakedValues: [] },
  agentTool: { reachedWithToken: true },
  mittrTool: { reachedWithToken: true },
  guard: { checked: 3, refused: 0 },
};

test('the proof passes only when nothing leaked, the shell was refused and both tools still worked', () => {
  assert.equal(passed(clean), true);
  assert.equal(passed({ ...clean, shell: { ...clean.shell, ran: false } }), false);
  assert.equal(passed({ ...clean, shell: { ...clean.shell, leakedNames: ['ACME_TOKEN'] } }), false);
  assert.equal(passed({ ...clean, shell: { ...clean.shell, engineStatus: '200' } }), false);
  assert.equal(passed({ ...clean, shell: { ...clean.shell, toolsCallbackStatus: '200' } }), false);
  assert.equal(passed({ ...clean, terminal: { ...clean.terminal, leakedValues: ['ACME_TOKEN'] } }), false);
  assert.equal(passed({ ...clean, agentTool: { reachedWithToken: false } }), false);
  assert.equal(passed({ ...clean, mittrTool: { reachedWithToken: false } }), false);
  assert.equal(passed({ ...clean, guard: { checked: 3, refused: 1 } }), false);
});
