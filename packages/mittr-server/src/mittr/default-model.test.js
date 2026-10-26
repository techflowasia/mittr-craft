import assert from 'node:assert/strict';
import test from 'node:test';

import { syncDefaultModel } from './default-model.js';

const fakeUserConfig = (initial) => {
  let stored = structuredClone(initial);
  const writes = [];
  return {
    writes,
    current: () => stored,
    read: () => structuredClone(stored),
    write: (config) => {
      writes.push(structuredClone(config));
      stored = structuredClone(config);
    },
  };
};

const sync = (userConfig, modelIds) => syncDefaultModel({ userConfig, providerId: 'mittr', modelIds });

test('empty config adopts the first agent', () => {
  const userConfig = fakeUserConfig({});
  assert.equal(sync(userConfig, ['a1', 'a2']), true);
  assert.deepEqual(userConfig.writes, [{ model: 'mittr/a1' }]);
  assert.equal(sync(userConfig, ['a1', 'a2']), false);
  assert.equal(userConfig.writes.length, 1);
});

test('withdrawn default moves to the next agent', () => {
  const userConfig = fakeUserConfig({ model: 'mittr/a1', provider: { other: { name: 'Other' } } });
  assert.equal(sync(userConfig, ['a2']), true);
  assert.deepEqual(userConfig.writes, [{ model: 'mittr/a2', provider: { other: { name: 'Other' } } }]);
});

test('default on another provider is untouched', () => {
  const userConfig = fakeUserConfig({ model: 'openai/gpt-x' });
  assert.equal(sync(userConfig, ['a1']), false);
  assert.equal(sync(userConfig, []), false);
  assert.deepEqual(userConfig.writes, []);
});

test('no agents clears only a Mittr default', () => {
  const mittr = fakeUserConfig({ model: 'mittr/a1', theme: 'dark' });
  assert.equal(sync(mittr, []), true);
  assert.deepEqual(mittr.writes, [{ theme: 'dark' }]);
  assert.equal(sync(mittr, []), false);

  const none = fakeUserConfig({ theme: 'dark' });
  assert.equal(sync(none, []), false);
  assert.deepEqual(none.writes, []);
});

test('a Mittr default the person picked stays while it is offered, with its variant', () => {
  const picked = fakeUserConfig({ model: 'mittr/a2' });
  assert.equal(sync(picked, ['a1', 'a2']), false);

  const withVariant = fakeUserConfig({ model: 'mittr/a2#high' });
  assert.equal(sync(withVariant, ['a1', 'a2']), false);
  assert.equal(sync(withVariant, ['a1']), true);
  assert.equal(withVariant.current().model, 'mittr/a1');
  assert.deepEqual([...picked.writes, ...withVariant.writes.slice(0, -1)], []);
});

test('the engine\'s explicit form is read the same way as the short one', () => {
  const other = fakeUserConfig({ model: { providerID: 'openai', model: 'gpt-x' } });
  assert.equal(sync(other, ['a1']), false);
  assert.equal(sync(other, []), false);
  assert.deepEqual(other.writes, []);

  const kept = fakeUserConfig({ model: { providerID: 'mittr', model: 'a2', variant: 'high' } });
  assert.equal(sync(kept, ['a1', 'a2']), false);

  const withdrawn = fakeUserConfig({ model: { providerID: 'mittr', model: 'gone' } });
  assert.equal(sync(withdrawn, ['a1']), true);
  assert.equal(withdrawn.current().model, 'mittr/a1');
  assert.equal(sync(withdrawn, []), true);
  assert.equal(Object.hasOwn(withdrawn.current(), 'model'), false);
});

test('a default it cannot read is never replaced', () => {
  for (const model of [42, ['mittr/a1'], { providerID: 'mittr' }, 'no-slash']) {
    const userConfig = fakeUserConfig({ model });
    assert.equal(sync(userConfig, ['a1']), false, JSON.stringify(model));
    assert.equal(sync(userConfig, []), false, JSON.stringify(model));
    assert.deepEqual(userConfig.writes, [], JSON.stringify(model));
  }
});

test('a blank default counts as none', () => {
  const userConfig = fakeUserConfig({ model: '  ' });
  assert.equal(sync(userConfig, ['a1']), true);
  assert.equal(userConfig.current().model, 'mittr/a1');
});

test('a config that cannot be read is not written', () => {
  const writes = [];
  const userConfig = {
    read: () => { throw new Error('Failed to read OpenCode configuration'); },
    write: (config) => writes.push(config),
  };
  assert.throws(() => sync(userConfig, ['a1']), /Failed to read OpenCode configuration/);
  assert.deepEqual(writes, []);
});
