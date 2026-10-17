import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

let proxyAnswer: () => Promise<Response> = async () => { throw new Error('server unreachable'); };

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async () => proxyAnswer()),
}));

const { registerProductUiPlugin, resetProductUiPluginsForTests } = await import('@/lib/product-plugins');
const { fetchModelsDevMetadata } = await import('./useConfigStore');

const realFetch = globalThis.fetch;
let directCalls: string[] = [];

beforeEach(() => {
  directCalls = [];
  proxyAnswer = async () => { throw new Error('server unreachable'); };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    directCalls.push(String(input));
    return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetProductUiPluginsForTests();
});

describe('models.dev metadata', () => {
  test('when the server cannot answer, the window asks models.dev itself', async () => {
    await fetchModelsDevMetadata();
    expect(directCalls).toEqual(['https://models.dev/api.json']);
  });

  test('with the remote model catalog turned off the window never asks models.dev', async () => {
    registerProductUiPlugin({ id: 'offline', remoteModelCatalog: false });
    const metadata = await fetchModelsDevMetadata();
    expect(directCalls).toEqual([]);
    expect(metadata.size).toBe(0);
  });

  test('with it turned off the server answer is still used', async () => {
    registerProductUiPlugin({ id: 'offline', remoteModelCatalog: false });
    proxyAnswer = async () => new Response(JSON.stringify({
      example: { id: 'example', models: { m1: { id: 'm1', name: 'M1', limit: { context: 1000, output: 100 } } } },
    }), { headers: { 'Content-Type': 'application/json' } });
    const metadata = await fetchModelsDevMetadata();
    expect(directCalls).toEqual([]);
    expect(metadata.size).toBe(1);
  });
});
