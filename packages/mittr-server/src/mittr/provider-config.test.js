import assert from 'node:assert/strict';
import test from 'node:test';

import { loopbackProxyExemption, mittrProviderFragment, shimBaseUrl } from './provider-config.js';

test('provider fragment for two agents', () => {
  const fragment = mittrProviderFragment({
    shimBaseUrl: 'http://127.0.0.1:4100/mittr-shim/v1',
    models: [{ alias: 'a1', label: 'Writer' }, { alias: 'a2', label: '' }],
  });
  assert.deepEqual(fragment, {
    providers: {
      mittr: {
        name: 'Mittr',
        package: 'aisdk:@ai-sdk/openai-compatible',
        settings: { baseURL: 'http://127.0.0.1:4100/mittr-shim/v1' },
        models: {
          a1: { modelID: 'a1', name: 'Writer', capabilities: { tools: true } },
          a2: { modelID: 'a2', name: 'a2', capabilities: { tools: true } },
        },
      },
    },
  });
  assert.equal(fragment.providers.mittr.models.a2.name, 'a2');
});

test('no agents means no provider', () => {
  assert.deepEqual(mittrProviderFragment({ shimBaseUrl: 'http://127.0.0.1:4100/mittr-shim/v1', models: [] }), {});
});

test('an alias that names an object key stays a plain model entry', () => {
  const fragment = mittrProviderFragment({ shimBaseUrl: 'http://127.0.0.1:1/mittr-shim/v1', models: [{ alias: '__proto__', label: 'P' }] });
  assert.deepEqual(Object.keys(fragment.providers.mittr.models), ['__proto__']);
  assert.equal(Object.getPrototypeOf(fragment.providers.mittr.models), Object.prototype);
});

test('the shim base URL is the loopback address on the server port', () => {
  assert.equal(shimBaseUrl(4100), 'http://127.0.0.1:4100/mittr-shim/v1');
});

test('loopback is exempted from the proxy in both spellings, keeping what the person already exempts', () => {
  assert.deepEqual(loopbackProxyExemption({}), { NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' });
  assert.deepEqual(loopbackProxyExemption({ NO_PROXY: 'corp.example, .internal' }), {
    NO_PROXY: 'corp.example,.internal,127.0.0.1,localhost',
    no_proxy: 'corp.example,.internal,127.0.0.1,localhost',
  });
  assert.deepEqual(loopbackProxyExemption({ NO_PROXY: 'a.example', no_proxy: 'localhost,b.example' }), {
    NO_PROXY: 'a.example,127.0.0.1,localhost',
    no_proxy: 'localhost,b.example,127.0.0.1',
  });
  assert.deepEqual(loopbackProxyExemption({ no_proxy: '127.0.0.1,localhost' }), {
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  });
});
