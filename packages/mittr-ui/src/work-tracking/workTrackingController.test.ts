import { describe, expect, test } from 'bun:test';

import { listenAnyAccountChange } from '../sign-in/accountChange';
import { setSignedInAccount, signedInAccount } from '../sign-in/signedInAccount';
import { mittrT } from '../strings/mittrT';
import {
  IntegrationsRequestError,
  type IntegrationsApi,
  type IntegrationsConfig,
  type IntegrationsSaveBody,
  type IntegrationTestResult,
} from './integrationsApi';
import { createWorkTrackingController, workTrackingStateFor } from './workTrackingController';
import { KEEP_PLACEHOLDER } from './workTrackingForm';

const configFor = (userId: string | null, overrides: Partial<IntegrationsConfig> = {}): IntegrationsConfig => ({
  jira: { baseUrl: `https://${userId}.atlassian.net`, email: `${userId}@acme.test`, hasToken: true, configured: true },
  plane: { baseUrl: 'https://plane.example.com', workspaceSlug: 'alpha', workspaceSlugs: ['alpha'], hasApiKey: true, configured: true },
  userId,
  ...overrides,
});

type Deferred<T> = { resolve: (value: T) => void; reject: (error: Error) => void };

const setup = (account: { current: string | null } = { current: 'u-a' }) => {
  const loads: Deferred<IntegrationsConfig>[] = [];
  const saves: Array<Deferred<IntegrationsConfig> & { body: IntegrationsSaveBody }> = [];
  const tests: Array<Deferred<IntegrationTestResult> & { which: 'jira' | 'plane' }> = [];
  const api: IntegrationsApi = {
    load: () => new Promise((resolve, reject) => { loads.push({ resolve, reject }); }),
    save: (body) => new Promise((resolve, reject) => { saves.push({ resolve, reject, body }); }),
    testJira: () => new Promise((resolve, reject) => { tests.push({ resolve, reject, which: 'jira' }); }),
    testPlane: () => new Promise((resolve, reject) => { tests.push({ resolve, reject, which: 'plane' }); }),
  };
  const accountListeners = new Set<() => void>();
  const controller = createWorkTrackingController({
    api,
    currentUserId: () => account.current,
    listenAccountChanged: (onChange) => {
      accountListeners.add(onChange);
      return () => { accountListeners.delete(onChange); };
    },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const accountChanged = () => { for (const listener of [...accountListeners]) listener(); };
  const loaded = async (config: IntegrationsConfig) => {
    loads[loads.length - 1].resolve(config);
    await settle();
  };
  return { controller, loads, saves, tests, settle, accountChanged, accountListeners, account, loaded };
};

const setupReal = (initial: string) => {
  const before = signedInAccount();
  setSignedInAccount(initial);
  const loads: Deferred<IntegrationsConfig>[] = [];
  const saves: Array<Deferred<IntegrationsConfig> & { body: IntegrationsSaveBody }> = [];
  const api: IntegrationsApi = {
    load: () => new Promise((resolve, reject) => { loads.push({ resolve, reject }); }),
    save: (body) => new Promise((resolve, reject) => { saves.push({ resolve, reject, body }); }),
    testJira: async () => ({ ok: false }),
    testPlane: async () => ({ ok: false }),
  };
  const controller = createWorkTrackingController({ api, currentUserId: signedInAccount, listenAccountChanged: listenAnyAccountChange });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const loaded = async (config: IntegrationsConfig) => {
    loads[loads.length - 1].resolve(config);
    await settle();
  };
  const restore = () => {
    controller.dispose();
    setSignedInAccount(before);
  };
  return { controller, loads, saves, settle, loaded, restore };
};

describe('work tracking controller', () => {
  test('the form loads for the current account', async () => {
    const { controller, loads, loaded } = setup();
    expect(controller.state().status).toBe('loading');
    void controller.refresh();
    expect(loads).toHaveLength(1);
    await loaded(configFor('u-a'));
    const state = controller.state();
    expect(state.status).toBe('ready');
    expect(state.loadedFor).toBe('u-a');
    expect(state.jira).toEqual({ baseUrl: 'https://u-a.atlassian.net', email: 'u-a@acme.test', token: '' });
    expect(state.plane.workspaceSlugs).toEqual(['alpha']);
  });

  test('the token field is never filled from the server', async () => {
    const { controller, loaded } = setup();
    void controller.refresh();
    await loaded(configFor('u-a'));
    expect(controller.state().jira.token).toBe('');
    expect(controller.state().plane.apiKey).toBe('');
    expect(controller.state().config?.jira.hasToken).toBe(true);
    expect(JSON.stringify(controller.state())).not.toContain(KEEP_PLACEHOLDER);
  });

  test('an account change reloads the form and drops what was typed', async () => {
    const { controller, loads, loaded, accountChanged, account } = setup();
    void controller.refresh();
    await loaded(configFor('u-a'));
    controller.editJira({ token: 'typed-for-a', email: 'typed@acme.test' });
    controller.editPlane({ apiKey: 'plane-key-for-a' });
    controller.editNewWorkspace('beta');
    controller.addWorkspace();
    expect(controller.state().plane.workspaceSlugs).toEqual(['alpha', 'beta']);

    account.current = 'u-b';
    accountChanged();
    expect(loads).toHaveLength(2);
    expect(controller.state().status).toBe('loading');
    await loaded(configFor('u-b'));

    const state = controller.state();
    expect(state.loadedFor).toBe('u-b');
    expect(state.jira).toEqual({ baseUrl: 'https://u-b.atlassian.net', email: 'u-b@acme.test', token: '' });
    expect(state.plane).toEqual({ baseUrl: 'https://plane.example.com', workspaceSlugs: ['alpha'], apiKey: '' });
    expect(JSON.stringify(state)).not.toContain('typed');
    expect(JSON.stringify(state)).not.toContain('for-a');
  });

  test('a reply for another account is dropped and the form reloads once, then waits for the account to settle', async () => {
    const { controller, loads, loaded, accountChanged, account } = setup({ current: 'u-b' });
    void controller.refresh();
    await loaded(configFor('u-a'));
    expect(loads).toHaveLength(2);
    expect(controller.state().status).toBe('loading');
    await loaded(configFor('u-a'));
    expect(loads).toHaveLength(2);
    expect(controller.state().status).toBe('loading');
    expect(controller.state().loadedFor).toBeNull();

    account.current = 'u-a';
    accountChanged();
    await loaded(configFor('u-a'));
    expect(controller.state().loadedFor).toBe('u-a');
  });

  test('save is not offered while the form has not loaded for an account', async () => {
    const { controller, saves, loaded } = setup({ current: null });
    expect(await controller.saveJira()).toBeNull();
    expect(await controller.savePlane()).toBeNull();
    void controller.refresh();
    await loaded(configFor(null));
    expect(controller.state().loadedFor).toBeNull();
    expect(controller.state().status).toBe('error');
    expect(await controller.saveJira()).toBeNull();
    expect(saves).toHaveLength(0);
  });

  test('a save names the account the form was loaded for, even when the window learns of another account while it is on its way', async () => {
    const real = setupReal('u-a');
    try {
      const { controller, saves, loads, loaded, settle } = real;
      void controller.refresh();
      await loaded(configFor('u-a'));
      controller.editJira({ token: 'typed-for-a' });

      const saving = controller.saveJira();
      expect(saves).toHaveLength(1);
      expect(saves[0].body).toEqual({
        jira: { baseUrl: 'https://u-a.atlassian.net', email: 'u-a@acme.test', token: 'typed-for-a' },
        expectUserId: 'u-a',
      });

      setSignedInAccount('u-b');
      expect(loads).toHaveLength(2);
      expect(controller.state().status).toBe('loading');
      expect(await controller.saveJira()).toBeNull();
      expect(saves).toHaveLength(1);

      saves[0].reject(new IntegrationsRequestError('The Mittr account changed. Open the settings again.', 409));
      await settle();
      expect(await saving).toBeNull();
      await loaded(configFor('u-b'));

      const state = controller.state();
      expect(state.loadedFor).toBe('u-b');
      expect(state.jira.token).toBe('');
      expect(state.notice).toBe(mittrT('mittr.workTracking.accountChanged'));
    } finally {
      real.restore();
    }
  });

  test('a save refused because the server is already on another account shows the notice once the window has caught up', async () => {
    const real = setupReal('u-a');
    try {
      const { controller, saves, loads, loaded, settle } = real;
      void controller.refresh();
      await loaded(configFor('u-a'));
      controller.editJira({ token: 'typed-for-a' });
      controller.editPlane({ apiKey: 'plane-key-for-a' });

      const saving = controller.saveJira();
      expect(saves[0].body.expectUserId).toBe('u-a');
      saves[0].reject(new IntegrationsRequestError('The Mittr account changed. Open the settings again.', 409));
      await settle();
      expect(loads).toHaveLength(2);
      await loaded(configFor('u-b'));
      expect(loads).toHaveLength(3);
      await loaded(configFor('u-b'));
      expect(await saving).toBeNull();
      expect(loads).toHaveLength(3);
      expect(controller.state().status).toBe('loading');
      expect(controller.state().loadedFor).toBeNull();

      setSignedInAccount('u-b');
      expect(loads).toHaveLength(4);
      await loaded(configFor('u-b'));

      const state = controller.state();
      expect(state.status).toBe('ready');
      expect(state.loadedFor).toBe('u-b');
      expect(state.notice).toBe(mittrT('mittr.workTracking.accountChanged'));
      expect(state.jira).toEqual({ baseUrl: 'https://u-b.atlassian.net', email: 'u-b@acme.test', token: '' });
      expect(state.plane.apiKey).toBe('');
      expect(JSON.stringify(state)).not.toContain('for-a');

      controller.editJira({ token: 'typed-for-b' });
      expect(controller.state().notice).toBeNull();
      void controller.saveJira();
      expect(saves).toHaveLength(2);
      expect(saves[1].body).toEqual({
        jira: { baseUrl: 'https://u-b.atlassian.net', email: 'u-b@acme.test', token: 'typed-for-b' },
        expectUserId: 'u-b',
      });
    } finally {
      real.restore();
    }
  });

  test('a refused save for a changed account reloads and says so', async () => {
    const { controller, saves, loads, loaded, settle } = setup();
    void controller.refresh();
    await loaded(configFor('u-a'));
    controller.editPlane({ apiKey: 'typed-key' });
    const saving = controller.savePlane();
    saves[0].reject(new IntegrationsRequestError('The Mittr account changed. Open the settings again.', 409));
    await settle();
    expect(loads).toHaveLength(2);
    await loaded(configFor('u-a'));
    expect(await saving).toBeNull();
    expect(controller.state().notice).toBe(mittrT('mittr.workTracking.accountChanged'));
    expect(controller.state().plane.apiKey).toBe('');
    expect(mittrT('mittr.workTracking.accountChanged')).not.toBe('mittr.workTracking.accountChanged');
  });

  test('a saved connection shows the saved note and keeps the other form as typed', async () => {
    const { controller, saves, loaded, settle } = setup();
    void controller.refresh();
    await loaded(configFor('u-a'));
    controller.editPlane({ baseUrl: 'https://plane.other.test' });
    controller.editJira({ token: 'new-token' });
    const saving = controller.saveJira();
    expect(controller.state().busy).toContain('saveJira');
    saves[0].resolve(configFor('u-a', { jira: { baseUrl: 'https://u-a.atlassian.net', email: 'u-a@acme.test', hasToken: true, configured: true } }));
    await settle();
    expect(await saving).toBeNull();
    const state = controller.state();
    expect(state.busy).toEqual([]);
    expect(state.savedNote).toBe('jira');
    expect(state.jira.token).toBe('');
    expect(state.plane.baseUrl).toBe('https://plane.other.test');

    controller.editJira({ email: 'next@acme.test' });
    expect(controller.state().savedNote).toBeNull();
  });

  test('a failed save keeps what was typed and says why', async () => {
    const { controller, saves, loaded, settle } = setup();
    void controller.refresh();
    await loaded(configFor('u-a'));
    controller.editJira({ token: 'typed' });
    const saving = controller.saveJira();
    saves[0].reject(new IntegrationsRequestError('Invalid body', 400));
    await settle();
    expect(await saving).toEqual({ tone: 'error', text: 'Invalid body' });
    expect(controller.state().jira.token).toBe('typed');
    expect(controller.state().savedNote).toBeNull();
  });

  test('the Plane test gives each workspace its own result', async () => {
    const { controller, tests, loaded, settle } = setup();
    void controller.refresh();
    await loaded(configFor('u-a', { plane: { baseUrl: 'https://plane.example.com', workspaceSlug: 'alpha', workspaceSlugs: ['alpha', 'beta'], hasApiKey: true, configured: true } }));
    const testing = controller.testPlane();
    expect(tests.map((entry) => entry.which)).toEqual(['plane']);
    tests[0].resolve({ ok: true, count: 5, workspaces: [{ slug: 'alpha', ok: true, count: 5 }, { slug: 'beta', ok: false, count: 0, error: 'Forbidden' }], userId: 'u-a' });
    await settle();
    expect(await testing).toEqual({ tone: 'success', text: 'Connected — 5 projects in 2 workspaces' });
    expect(controller.state().workspaceTests).toEqual({
      alpha: { slug: 'alpha', ok: true, count: 5 },
      beta: { slug: 'beta', ok: false, count: 0, error: 'Forbidden' },
    });
  });

  test('a connection test for another account reloads the form instead of showing it', async () => {
    const { controller, tests, loads, loaded, settle } = setup();
    void controller.refresh();
    await loaded(configFor('u-a'));
    const testing = controller.testJira();
    tests[0].resolve({ ok: true, displayName: 'Someone Else', userId: 'u-b' });
    await settle();
    expect(loads).toHaveLength(2);
    await loaded(configFor('u-a'));
    expect(await testing).toBeNull();
    expect(controller.state().notice).toBe(mittrT('mittr.workTracking.accountChanged'));
  });

  test('the Jira test names who it connected as, and a failure says why', async () => {
    const { controller, tests, loaded, settle } = setup();
    void controller.refresh();
    await loaded(configFor('u-a'));
    const first = controller.testJira();
    tests[0].resolve({ ok: true, displayName: 'Acme Person', userId: 'u-a' });
    await settle();
    expect(await first).toEqual({ tone: 'success', text: 'Connected as Acme Person' });
    const second = controller.testJira();
    tests[1].resolve({ ok: false, error: 'Unauthorized' });
    await settle();
    expect(await second).toEqual({ tone: 'error', text: 'Unauthorized' });
  });

  test('a workspace refusal shows its text until the field changes', async () => {
    const { controller, loaded } = setup();
    void controller.refresh();
    await loaded(configFor('u-a'));
    controller.editNewWorkspace('https://plane.example.com/alpha');
    controller.addWorkspace();
    expect(controller.state().workspaceError).toBe('alpha is already in the list');
    expect(controller.state().newWorkspace).toBe('https://plane.example.com/alpha');
    controller.editNewWorkspace('beta');
    expect(controller.state().workspaceError).toBeNull();
    controller.addWorkspace();
    expect(controller.state().plane.workspaceSlugs).toEqual(['alpha', 'beta']);
    expect(controller.state().newWorkspace).toBe('');
    controller.removeWorkspace('alpha');
    expect(controller.state().plane.workspaceSlugs).toEqual(['beta']);
  });

  test('a platform with one workspace takes one, and only while none is listed', async () => {
    const { controller, loaded } = setup();
    void controller.refresh();
    await loaded(configFor('u-a', { plane: { baseUrl: 'https://plane.example.com', workspaceSlug: 'alpha', hasApiKey: true, configured: true } }));
    controller.editNewWorkspace('beta');
    controller.addWorkspace();
    expect(controller.state().plane.workspaceSlugs).toEqual(['alpha']);
    controller.removeWorkspace('alpha');
    controller.addWorkspace();
    expect(controller.state().plane.workspaceSlugs).toEqual(['beta']);
  });

  test('a failed load says why, and nothing more is heard after dispose', async () => {
    const { controller, loads, accountListeners, accountChanged } = setup();
    void controller.refresh();
    loads[0].reject(new Error('Sign in to Mittr first'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.state()).toEqual({ ...workTrackingStateFor(null), status: 'error', error: 'Sign in to Mittr first' });
    controller.dispose();
    expect(accountListeners.size).toBe(0);
    accountChanged();
    expect(loads).toHaveLength(1);
  });
});
