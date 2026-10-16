import { afterEach, describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import fsPromises from 'fs/promises';

import { loadServerPlugins, mergeEngineConfig, readServerPluginSpecifiers } from './server-plugins.js';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsPromises.rm(root, { recursive: true, force: true })));
});

/** Writes each `source` as its own ESM module and returns their absolute paths. */
const writePlugins = async (...sources) => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-server-plugins-'));
  roots.push(root);
  return Promise.all(sources.map(async (source, index) => {
    const file = path.join(root, `plugin-${index}.mjs`);
    await fsPromises.writeFile(file, source);
    return file;
  }));
};

const context = () => ({ app: { name: 'app' }, dataDir: '/data', logger: console });

describe('server plugins', () => {
  it('loads plugins in order and merges engineEnv, later wins', async () => {
    const specifiers = await writePlugins(
      `export default async ({ dataDir, logger }) => {
        logger.info('first', dataDir);
        return { engineEnv: () => ({ SHARED: 'first', FIRST_ONLY: '1' }) };
      };`,
      'export default async () => ({});',
      `export default async ({ app, logger }) => {
        logger.info('third', app.name);
        return { engineEnv: async () => ({ SHARED: 'third', THIRD_ONLY: '3' }) };
      };`,
    );
    const calls = [];
    const logger = { info: (...args) => calls.push(args) };

    const plugins = await loadServerPlugins({ specifiers, context: { ...context(), logger } });

    expect(calls).toEqual([['first', '/data'], ['third', 'app']]);
    expect(await plugins.engineEnv()).toEqual({ SHARED: 'third', FIRST_ONLY: '1', THIRD_ONLY: '3' });
  });

  it('server start fails when a plugin setup rejects', async () => {
    const specifiers = await writePlugins(
      'export default async () => { throw new Error("setup failed"); };',
    );

    await expect(loadServerPlugins({ specifiers, context: context() })).rejects.toThrow('setup failed');
  });

  it('rejects a module without a default export function', async () => {
    const [specifier] = await writePlugins('export const notDefault = 1;');

    await expect(loadServerPlugins({ specifiers: [specifier], context: context() }))
      .rejects.toThrow(`${specifier} must export a default function`);
  });

  it('no OPENCHAMBER_SERVER_PLUGINS means no plugins', async () => {
    expect(readServerPluginSpecifiers({})).toEqual([]);
    expect(readServerPluginSpecifiers({ OPENCHAMBER_SERVER_PLUGINS: '' })).toEqual([]);
    expect(readServerPluginSpecifiers({ OPENCHAMBER_SERVER_PLUGINS: '  ' })).toEqual([]);

    const plugins = await loadServerPlugins({ specifiers: [], context: context() });
    expect(await plugins.engineEnv()).toEqual({});
    expect(await plugins.managedConfig()).toEqual({});
    await plugins.dispose();
  });

  it('managedConfig merges fragments in order', async () => {
    const specifiers = await writePlugins(
      `export default () => ({ managedConfig: () => ({
        providers: { a: { name: 'A' } },
        plugins: ['/p1'],
        experimental: { policies: [{ action: 'provider.use', resource: '*', effect: 'deny' }] },
      }) });`,
      'export default () => ({});',
      `export default () => ({ managedConfig: async () => ({
        providers: { a: { models: { m: {} } } },
        plugins: ['/p2'],
        experimental: { policies: [{ action: 'provider.use', resource: 'a', effect: 'allow' }] },
      }) });`,
    );

    const plugins = await loadServerPlugins({ specifiers, context: context() });

    expect(await plugins.managedConfig()).toEqual({
      providers: { a: { name: 'A', models: { m: {} } } },
      plugins: ['/p1', '/p2'],
      experimental: {
        policies: [
          { action: 'provider.use', resource: '*', effect: 'deny' },
          { action: 'provider.use', resource: 'a', effect: 'allow' },
        ],
      },
    });
  });

  it('mergeEngineConfig lets the later fragment win on scalars and other arrays', () => {
    expect(mergeEngineConfig(
      { model: 'a/m', share: 'auto', instructions: ['one'], experimental: { flag: true } },
      { model: 'b/m', instructions: ['two'], experimental: { policies: [] } },
    )).toEqual({ model: 'b/m', share: 'auto', instructions: ['two'], experimental: { flag: true, policies: [] } });
  });

  it('dispose runs every plugin\'s dispose in reverse order', async () => {
    const specifiers = await writePlugins(
      "export default ({ calls }) => ({ dispose: () => { calls.push('p1'); } });",
      'export default () => ({});',
      "export default ({ calls }) => ({ dispose: async () => { calls.push('p2'); } });",
    );
    const calls = [];

    const plugins = await loadServerPlugins({ specifiers, context: { ...context(), calls } });
    await plugins.dispose();

    expect(calls).toEqual(['p2', 'p1']);
  });

  it('a failing dispose does not skip the plugins before it', async () => {
    const specifiers = await writePlugins(
      "export default ({ calls }) => ({ dispose: () => { calls.push('p1'); } });",
      'export default () => ({ dispose: () => { throw new Error("stuck"); } });',
    );
    const calls = [];
    const warnings = [];
    const logger = { warn: (...args) => warnings.push(args.join(' ')) };

    const plugins = await loadServerPlugins({ specifiers, context: { ...context(), logger, calls } });
    await plugins.dispose();

    expect(calls).toEqual(['p1']);
    expect(warnings).toEqual([expect.stringContaining('stuck')]);
  });

  it('context is handed through unchanged', async () => {
    const [specifier] = await writePlugins(
      `export default (context) => { context.seen.push(context); return {}; };`,
    );
    const seen = [];
    const handed = {
      ...context(),
      seen,
      express: { json: () => {} },
      server: { port: () => null },
      opencode: { url: (route = '') => `http://127.0.0.1:1${route}`, onReady: () => () => {} },
      mergeEngineConfig,
    };

    await loadServerPlugins({ specifiers: [specifier], context: handed });

    const [received] = seen;
    expect(received).toBe(handed);
    for (const handle of [
      received.opencode.url,
      received.express.json,
      received.server.port,
      received.opencode.onReady,
      received.mergeEngineConfig,
    ]) {
      expect(handle).toBeTypeOf('function');
    }
  });

  it('reads the plugin paths from OPENCHAMBER_SERVER_PLUGINS', () => {
    const env = { OPENCHAMBER_SERVER_PLUGINS: JSON.stringify(['/opt/app/a.mjs', '/opt/app/b.mjs']) };
    expect(readServerPluginSpecifiers(env)).toEqual(['/opt/app/a.mjs', '/opt/app/b.mjs']);
  });

  it('names OPENCHAMBER_SERVER_PLUGINS when its value cannot be used', () => {
    expect(() => readServerPluginSpecifiers({ OPENCHAMBER_SERVER_PLUGINS: '[not json' }))
      .toThrow(/^OPENCHAMBER_SERVER_PLUGINS is not valid JSON/);
    expect(() => readServerPluginSpecifiers({ OPENCHAMBER_SERVER_PLUGINS: '"/opt/app/a.mjs"' }))
      .toThrow('OPENCHAMBER_SERVER_PLUGINS must be a JSON array of absolute file paths');
    expect(() => readServerPluginSpecifiers({ OPENCHAMBER_SERVER_PLUGINS: '["relative/a.mjs"]' }))
      .toThrow('OPENCHAMBER_SERVER_PLUGINS must be a JSON array of absolute file paths');
  });
});
