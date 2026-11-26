import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fsPromises from 'fs/promises';
import { fileURLToPath } from 'node:url';

import { createServiceHostApi } from './guests/service-host-api.js';
import { createPermissionAutoAcceptRuntime } from './permission-auto-accept/runtime.js';
import { createProgramAnswerGuard, loadServerPlugins, mergeEngineConfig, readServerPluginSpecifiers } from './server-plugins.js';

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

  it('neverAutoAnswer is true when any plugin answers true', async () => {
    const specifiers = await writePlugins(
      'export default () => ({ neverAutoAnswer: (permission) => permission.action === "acme_browser" });',
      'export default () => ({});',
      'export default () => ({ neverAutoAnswer: () => false });',
    );

    const plugins = await loadServerPlugins({ specifiers, context: context() });

    expect(plugins.neverAutoAnswer({ action: 'acme_browser' })).toBe(true);
    expect(plugins.neverAutoAnswer({ action: 'bash' })).toBe(false);
  });

  it('a plugin that throws in neverAutoAnswer holds the request', async () => {
    const specifiers = await writePlugins(
      'export default () => ({ neverAutoAnswer: () => { throw new Error("acme failed"); } });',
    );

    const plugins = await loadServerPlugins({ specifiers, context: context() });

    expect(plugins.neverAutoAnswer({ action: 'bash' })).toBe(true);
  });

  it('without a plugin that marks requests none is held', async () => {
    const plugins = await loadServerPlugins({ specifiers: await writePlugins('export default () => ({});'), context: context() });

    expect(plugins.neverAutoAnswer({ action: 'acme_browser' })).toBe(false);
  });

  it('goalContinuation joins the plugins\' notes and lets the first block win', async () => {
    const specifiers = await writePlugins(
      'export default () => ({ goalContinuation: async (input) => ({ note: `first ${input.sessionId}` }) });',
      'export default () => ({});',
      'export default () => ({ goalContinuation: () => ({ note: "second" }) });',
    );
    const blocking = await writePlugins(
      'export default () => ({ goalContinuation: () => ({ note: "kept out" }) });',
      'export default () => ({ goalContinuation: () => ({ block: "looping: same command 35 times" }) });',
      'export default () => ({ goalContinuation: () => { throw new Error("never asked"); } });',
    );
    const input = { sessionId: 'ses_1', directory: '/repo', goalId: 'goal_1', resumed: false };

    const notes = await loadServerPlugins({ specifiers, context: context() });
    const blocks = await loadServerPlugins({ specifiers: blocking, context: context() });

    expect(await notes.goalContinuation(input)).toEqual({ block: '', note: 'first ses_1\n\nsecond' });
    expect(await blocks.goalContinuation(input)).toEqual({ block: 'looping: same command 35 times', note: '' });
  });

  it('a plugin whose goalContinuation fails is left out with a warning', async () => {
    const warnings = [];
    const specifiers = await writePlugins(
      'export default () => ({ goalContinuation: async () => { throw new Error("acme failed"); } });',
      'export default () => ({ goalContinuation: () => ({ note: "still here" }) });',
    );

    const plugins = await loadServerPlugins({ specifiers, context: { ...context(), logger: { warn: (...args) => warnings.push(args.join(' ')) } } });

    expect(await plugins.goalContinuation({ sessionId: 'ses_1', directory: '', goalId: 'goal_1', resumed: false })).toEqual({ block: '', note: 'still here' });
    expect(warnings).toEqual([expect.stringContaining('acme failed')]);
  });

  it('goalEnded tells every plugin, and one that fails does not stop the others', async () => {
    const warnings = [];
    const [first, second] = await writePlugins(
      'export default (context) => ({ goalEnded: async () => { throw new Error("acme failed"); } });',
      'export default (context) => ({ goalEnded: (input) => { context.seen.push(input); } });',
    );
    const seen = [];
    const plugins = await loadServerPlugins({ specifiers: [first, second], context: { ...context(), seen, logger: { warn: (...args) => warnings.push(args.join(' ')) } } });

    await plugins.goalEnded({ sessionId: 'ses_1', directory: '/repo', reason: 'complete' });

    expect(seen).toEqual([{ sessionId: 'ses_1', directory: '/repo', reason: 'complete' }]);
    expect(warnings).toEqual([expect.stringContaining('acme failed')]);
  });

  it('says whether any plugin marks permission requests', async () => {
    const marking = await loadServerPlugins({ specifiers: await writePlugins('export default () => ({ neverAutoAnswer: () => false });'), context: context() });
    const plain = await loadServerPlugins({ specifiers: await writePlugins('export default () => ({});'), context: context() });

    expect(marking.holdsPermissions).toBe(true);
    expect(plain.holdsPermissions).toBe(false);
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

describe('a permission request answered by an extension', () => {
  const setUp = async (source, engine) => {
    const plugins = await loadServerPlugins({ specifiers: await writePlugins(source), context: context() });
    const fetchImpl = vi.fn(engine);
    const runtime = createPermissionAutoAcceptRuntime({
      globalEventHub: { subscribeEvent: () => () => {}, subscribeStatus: () => () => {} },
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      readSettingsFromDiskMigrated: async () => ({}),
      persistSettings: async () => {},
      neverAutoAnswer: (permission) => plugins.neverAutoAnswer(permission) === true,
      fetchImpl,
    });
    const answer = vi.fn(async () => {});
    const api = createServiceHostApi({
      listGuests: async () => [{
        id: 'desk',
        name: 'Desk',
        enabled: true,
        service: { entry: 'service/main.js', runtime: 'host' },
        sessionControl: { answers: true },
        capabilityGrants: ['service', 'sessionControl', 'sessionAnswers'],
      }],
      control: {
        answerPermission: createProgramAnswerGuard({
          holdsPermissions: () => plugins.holdsPermissions,
          isLeftForPerson: runtime.isLeftForPerson,
          answer,
        }),
      },
      guestIdOfToken: () => 'desk',
    });
    const call = (decision) => api.serve({ bearer: 'live', body: { method: 'sessions.answerPermission', input: { sessionId: 'ses_1', requestId: 'per_1', decision } } });
    return { answer, call, fetchImpl };
  };

  const MARKS_BROWSER = 'export default () => ({ neverAutoAnswer: (permission) => permission.action === "acme_browser" });';
  const pending = (action) => async () => Response.json({ data: { id: 'per_1', sessionID: 'ses_1', action, resources: ['api.example.test'] } });

  it.each(['allow', 'deny'])('is refused on %s when a plugin leaves it for the person', async (decision) => {
    const { answer, call, fetchImpl } = await setUp(MARKS_BROWSER, pending('acme_browser'));

    expect(await call(decision)).toMatchObject({ status: 403, body: { error: { message: 'This request has to be answered by the person in the app' } } });
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://opencode.test/api/session/ses_1/permission/per_1');
    expect(answer).not.toHaveBeenCalled();
  });

  it('goes through when no plugin marks it, and when no plugin marks any the engine is not asked', async () => {
    const marked = await setUp(MARKS_BROWSER, pending('bash'));
    expect(await marked.call('allow')).toEqual({ status: 200, body: { result: { answered: true } } });
    expect(marked.answer).toHaveBeenCalledWith({ sessionID: 'ses_1', requestID: 'per_1', decision: 'once', message: undefined });

    const plain = await setUp('export default () => ({});', pending('acme_browser'));
    expect(await plain.call('allow')).toMatchObject({ status: 200 });
    expect(plain.fetchImpl).not.toHaveBeenCalled();
  });

  it('is refused when the request cannot be read or does not parse', async () => {
    const down = await setUp(MARKS_BROWSER, async () => new Response('', { status: 500 }));
    expect(await down.call('allow')).toMatchObject({ status: 500 });
    expect(down.answer).not.toHaveBeenCalled();

    const unread = await setUp(MARKS_BROWSER, async () => new Response('not json'));
    expect(await unread.call('allow')).toMatchObject({ status: 403 });
    expect(unread.answer).not.toHaveBeenCalled();
  });

  it('that already settled is left for the answer call to say so', async () => {
    const gone = await setUp(MARKS_BROWSER, async () => new Response('', { status: 404 }));
    expect(await gone.call('allow')).toMatchObject({ status: 200 });
    expect(gone.answer).toHaveBeenCalledTimes(1);
  });

  it('has no other way to be answered by the server than the two that check the plugins', async () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const files = (await fsPromises.readdir(root, { recursive: true })).filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'));
    const replying = [];
    for (const file of files) {
      const source = await fsPromises.readFile(path.join(root, file), 'utf8');
      if (/permission\.reply\(|\/permission\/\$\{.*\/reply`/.test(source)) replying.push(file.split(path.sep).join('/'));
    }
    expect(replying.sort()).toEqual(['lib/openchamber-control/service.ts', 'lib/permission-auto-accept/runtime.ts']);

    const runtime = await fsPromises.readFile(path.join(root, 'runtime.ts'), 'utf8');
    expect(runtime.split('openChamberControlService.answerPermission').length - 1).toBe(2);
    expect(runtime).toMatch(/answerPermission: createProgramAnswerGuard\(\{[^}]*isLeftForPerson: async [^}]*answer: [^}]*openChamberControlService\.answerPermission\(input\),\s*\}\),/);
  });
});
