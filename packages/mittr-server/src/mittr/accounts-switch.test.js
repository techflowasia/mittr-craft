import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { activeAccountHome } from '../accounts.js';
import { ENGINE_DB_RULE, engineBases, engineEnv, sharedHistoryExists } from '../engine-home.js';
import { createAccountStore } from './account-store.js';
import { createAccountSwitcher } from './accounts-switch.js';
import { registerMittrAuthRoutes } from './auth-routes.js';
import { decrypt, deferred, encrypt, fakeFetch, json, serve, tempDataDir } from './test-helpers.js';

const NOW = 1_800_000_000_000;
const BROKER = { baseUrl: 'https://api-dev.mittr.asia', upstreamV1: 'https://api-dev.mittr.asia/v1', fixed: false };
const DEV_CALLBACK = 'mittrcraft-dev://auth/callback';
const SWITCHED = 'mittr account switched';

const homeOf = (userId) => crypto.createHash('sha256').update(userId).digest('hex').slice(0, 16);

const sessionFor = (userId, displayName, over = {}) => ({
  accessToken: `at-${userId}`,
  refreshToken: `r-${userId}`,
  expiresAt: NOW + 3_600_000,
  subject: { userId, displayName },
  ...over,
});

const A = sessionFor('u-a', 'A');
const B = sessionFor('u-b', 'B');

const quietLogger = () => {
  const warnings = [];
  return { warnings, log: () => {}, warn: (...args) => warnings.push(args.join(' ')), error: () => {} };
};

const harness = async (t, { sharedHistory = false, sessions = [], exchanges = [], fetchImpl = null, sync = async () => {} } = {}) => {
  const root = tempDataDir(t);
  const dataDir = path.join(root, 'data');
  const bases = engineBases({ homeDir: root, env: { MITTRCRAFT_ENGINE_HOME: path.join(root, 'engine') } });
  if (sharedHistory) {
    fs.mkdirSync(path.join(bases.data, 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(bases.data, 'opencode', 'opencode.db'), 'sessions');
  }
  const store = createAccountStore({ dataDir, encrypt, decrypt, sharedHistoryExists: () => sharedHistoryExists(bases) });
  for (const session of sessions) store.write(session, { activate: false });

  const refreshes = [];
  const applied = [];
  const syncs = [];
  const switches = [];
  const signIns = [];
  const logger = quietLogger();
  const opencode = { refresh: async (reason) => { refreshes.push(reason); } };
  const switcher = createAccountSwitcher({
    store,
    opencode,
    applyCache: async () => { applied.push(store.activeHome()); },
    sync: () => {
      syncs.push(store.read()?.subject.userId ?? null);
      return sync();
    },
    logger,
  });

  let exchanged = 0;
  const platform = fetchImpl ?? fakeFetch((request) => {
    if (request.url.endsWith('/auth/desktop/exchange')) {
      exchanged += 1;
      return json(exchanges[exchanged - 1]);
    }
    return json({});
  });
  const clock = { now: NOW };
  const app = express();
  const auth = registerMittrAuthRoutes(app, {
    express,
    broker: BROKER,
    store,
    scheme: 'mittrcraft-dev',
    fetchImpl: platform,
    now: () => clock.now,
    onSignIn: (previousUserId, nextUserId) => {
      signIns.push([previousUserId, nextUserId]);
      return switcher.afterSignIn(previousUserId, nextUserId);
    },
    onAccountChange: (next) => {
      switches.push(next);
      return switcher.switchTo(next);
    },
    logger,
  });
  const engineEnvNow = () => engineEnv({ bases, accountHome: activeAccountHome(dataDir, { logger }), rule: ENGINE_DB_RULE });
  return { auth, store, switcher, bases, dataDir, refreshes, applied, syncs, switches, signIns, logger, engineEnvNow, call: await serve(t, app) };
};

const signIn = async (call) => {
  assert.equal((await call('POST', '/api/mittr/auth/start')).status, 200);
  return call('POST', '/api/mittr/auth/callback', { url: `${DEV_CALLBACK}?code=c1` });
};

const indexOf = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, 'mittr-accounts', 'index.json'), 'utf8'));

test('adding B keeps A signed in and activates B', async (t) => {
  const { call, store, dataDir } = await harness(t, { exchanges: [A, B] });
  assert.equal((await signIn(call)).status, 200);

  assert.deepEqual((await signIn(call)).body, { signedIn: true, userId: 'u-b', displayName: 'B' });

  assert.deepEqual(store.list(), [
    { userId: 'u-a', displayName: 'A', active: false },
    { userId: 'u-b', displayName: 'B', active: true },
  ]);
  assert.equal(store.read().subject.userId, 'u-b');
  assert.equal(store.readOf('u-a').subject.userId, 'u-a');
  const index = indexOf(dataDir);
  assert.equal(index.active, 'u-b');
  assert.equal(index.accounts.find((entry) => entry.userId === 'u-b').home, homeOf('u-b'));
  assert.equal(index.accounts.find((entry) => entry.userId === 'u-a').home, null);
});

test('switching restarts the engine once on the other home', async (t) => {
  const { switcher, refreshes, bases, engineEnvNow } = await harness(t, { sessions: [A, B] });
  assert.equal(engineEnvNow().XDG_DATA_HOME, bases.data);

  assert.deepEqual(await switcher.switchTo('u-b'), { signedIn: true, userId: 'u-b', displayName: 'B' });

  assert.deepEqual(refreshes, [SWITCHED]);
  assert.ok(engineEnvNow().XDG_DATA_HOME.endsWith(path.join('accounts', homeOf('u-b'))), engineEnvNow().XDG_DATA_HOME);
  assert.ok(engineEnvNow().XDG_STATE_HOME.endsWith(path.join('accounts', homeOf('u-b'))), engineEnvNow().XDG_STATE_HOME);
});

test('switching back to the first account uses the shared home', async (t) => {
  const { switcher, store, refreshes, bases, engineEnvNow } = await harness(t, { sessions: [A, B] });
  assert.equal(store.activeHome(), null);
  await switcher.switchTo('u-b');

  await switcher.switchTo('u-a');

  assert.deepEqual(refreshes, [SWITCHED, SWITCHED]);
  assert.equal(engineEnvNow().XDG_DATA_HOME, bases.data);
  assert.equal(engineEnvNow().XDG_DATA_HOME.includes(`${path.sep}accounts${path.sep}`), false);
});

test('switching back to a first account that got its own home uses that home', async (t) => {
  const { switcher, store, refreshes, bases, engineEnvNow } = await harness(t, { sharedHistory: true, sessions: [A, B] });
  assert.equal(store.activeHome(), homeOf('u-a'));
  await switcher.switchTo('u-b');

  await switcher.switchTo('u-a');

  assert.deepEqual(refreshes, [SWITCHED, SWITCHED]);
  assert.equal(engineEnvNow().XDG_DATA_HOME, path.join(bases.data, 'accounts', homeOf('u-a')));
});

test('a switch applies the account\'s cache before the restart, then syncs without waiting for it', async (t) => {
  const never = deferred();
  const { switcher, applied, syncs, refreshes } = await harness(t, { sessions: [A, B], sync: () => never.promise });

  assert.equal((await switcher.switchTo('u-b')).userId, 'u-b');

  assert.deepEqual(applied, [homeOf('u-b')]);
  assert.deepEqual(refreshes, [SWITCHED]);
  assert.deepEqual(syncs, ['u-b']);
});

test('a switch onto the home the engine already runs on does not restart it', async (t) => {
  const { switcher, refreshes, applied, syncs } = await harness(t, { sessions: [A, B] });

  assert.equal((await switcher.switchTo('u-a')).userId, 'u-a');

  assert.deepEqual(refreshes, []);
  assert.deepEqual(applied, [null]);
  assert.deepEqual(syncs, ['u-a']);
});

test('the activate route restarts the engine, though the account is active before the switch is told', async (t) => {
  const { call, refreshes, switches, engineEnvNow } = await harness(t, { sessions: [A, B] });

  assert.deepEqual((await call('POST', '/api/mittr/auth/accounts/activate', { userId: 'u-b' })).body, { signedIn: true, userId: 'u-b', displayName: 'B' });

  assert.deepEqual(switches, ['u-b']);
  assert.deepEqual(refreshes, [SWITCHED]);
  assert.ok(engineEnvNow().XDG_DATA_HOME.endsWith(path.join('accounts', homeOf('u-b'))));
});

test('a first sign-in on the home the engine started on does not restart it', async (t) => {
  const { call, refreshes, switches } = await harness(t, { exchanges: [A] });

  assert.equal((await signIn(call)).status, 200);

  assert.deepEqual(switches, ['u-a']);
  assert.deepEqual(refreshes, []);
});

test('a first sign-in onto a home of its own restarts the engine there', async (t) => {
  const { call, refreshes, switches, bases, engineEnvNow } = await harness(t, { sharedHistory: true, exchanges: [A] });

  assert.equal((await signIn(call)).status, 200);

  assert.deepEqual(switches, ['u-a']);
  assert.deepEqual(refreshes, [SWITCHED]);
  assert.equal(engineEnvNow().XDG_DATA_HOME, path.join(bases.data, 'accounts', homeOf('u-a')));
});

test('signing in again as the active account only syncs', async (t) => {
  const { call, refreshes, switches, signIns, syncs } = await harness(t, { exchanges: [A, A] });
  assert.equal((await signIn(call)).status, 200);

  assert.equal((await signIn(call)).status, 200);

  assert.deepEqual(switches, ['u-a']);
  assert.deepEqual(signIns, [['u-a', 'u-a']]);
  assert.deepEqual(syncs, ['u-a', 'u-a']);
  assert.deepEqual(refreshes, []);
});

test('a refused refresh of an inactive account leaves the active account signed in', async (t) => {
  const refresh = deferred();
  const refreshAsked = deferred();
  const fetchImpl = fakeFetch((request) => {
    if (request.url.endsWith('/auth/desktop/refresh')) {
      refreshAsked.resolve();
      return refresh.promise;
    }
    return json({});
  });
  const expiringB = sessionFor('u-b', 'B', { expiresAt: NOW + 30_000 });
  const { auth, store, switcher, switches, refreshes } = await harness(t, { sessions: [A, expiringB], fetchImpl });
  await switcher.switchTo('u-b');

  const refreshing = auth.ensureFreshSession();
  await refreshAsked.promise;
  await switcher.switchTo('u-a');
  refresh.resolve(new Response(null, { status: 401 }));

  assert.equal(await refreshing, null);
  assert.equal(store.readOf('u-b'), null);
  assert.deepEqual(store.list(), [{ userId: 'u-a', displayName: 'A', active: true }]);
  assert.equal(store.read().subject.userId, 'u-a');
  assert.deepEqual(switches, []);
  assert.deepEqual(refreshes, [SWITCHED, SWITCHED]);
  const refreshCalls = fetchImpl.calls.filter((request) => request.url.endsWith('/auth/desktop/refresh'));
  assert.deepEqual(refreshCalls.map((request) => request.body.refresh_token), ['r-u-b']);
});

test('signing out of the active account switches to the next one', async (t) => {
  const { call, switches, refreshes, engineEnvNow } = await harness(t, { sessions: [A, B] });

  assert.deepEqual((await call('DELETE', '/api/mittr/auth/session')).body, { signedIn: true, userId: 'u-b', displayName: 'B' });

  assert.deepEqual(switches, ['u-b']);
  assert.deepEqual(refreshes, [SWITCHED]);
  assert.ok(engineEnvNow().XDG_DATA_HOME.endsWith(path.join('accounts', homeOf('u-b'))));
});

test('signing out of the last account switches to none', async (t) => {
  const { call, switcher, switches, refreshes, bases, engineEnvNow } = await harness(t, { sharedHistory: true, sessions: [A] });

  assert.deepEqual((await call('DELETE', '/api/mittr/auth/session')).body, { signedIn: false });

  assert.deepEqual(switches, [null]);
  assert.deepEqual(refreshes, [SWITCHED]);
  assert.equal(engineEnvNow().XDG_DATA_HOME, bases.data);
  assert.deepEqual(await switcher.switchTo(null), { signedIn: false });
  assert.deepEqual(refreshes, [SWITCHED]);
});

test('switching to none leaves every account signed in and none active', async (t) => {
  const { switcher, store, refreshes } = await harness(t, { sessions: [A, B] });
  await switcher.switchTo('u-b');

  assert.deepEqual(await switcher.switchTo(null), { signedIn: false });

  assert.deepEqual(store.list().map(({ userId, active }) => [userId, active]), [['u-a', false], ['u-b', false]]);
  assert.deepEqual(refreshes, [SWITCHED, SWITCHED]);
});

test('last active account survives a restart', async (t) => {
  const { switcher, dataDir } = await harness(t, { sessions: [A, B] });
  await switcher.switchTo('u-b');

  const reopened = createAccountStore({ dataDir, encrypt, decrypt, sharedHistoryExists: () => true });

  assert.equal(reopened.read().subject.userId, 'u-b');
  assert.deepEqual(reopened.list().find((account) => account.active), { userId: 'u-b', displayName: 'B', active: true });
  assert.equal(activeAccountHome(dataDir), homeOf('u-b'));
});

test('overlapping switches run one after another and end on the last', async (t) => {
  const { switcher, store, refreshes, engineEnvNow } = await harness(t, { sessions: [A, B] });

  const [first, second] = await Promise.all([switcher.switchTo('u-b'), switcher.switchTo('u-a')]);

  assert.equal(first.userId, 'u-b');
  assert.equal(second.userId, 'u-a');
  assert.equal(store.read().subject.userId, 'u-a');
  assert.deepEqual(refreshes, [SWITCHED, SWITCHED]);
  assert.equal(engineEnvNow().XDG_DATA_HOME.includes(`${path.sep}accounts${path.sep}`), false);
});

test('a restart that fails is logged, and the next switch compares against the home it was sent to', async (t) => {
  const { store, logger } = await harness(t, { sessions: [A, B] });
  const refreshes = [];
  const switcher = createAccountSwitcher({
    store,
    opencode: { refresh: async (reason) => { refreshes.push(reason); throw new Error('engine did not come back'); } },
    applyCache: async () => {},
    sync: async () => {},
    logger,
  });

  assert.equal((await switcher.switchTo('u-b')).userId, 'u-b');
  assert.ok(logger.warnings.some((line) => line.includes('engine did not come back')), logger.warnings.join('\n'));
  await switcher.switchTo('u-b');
  assert.deepEqual(refreshes, [SWITCHED]);
});

test('a sync that fails after a switch is logged, not thrown', async (t) => {
  const { switcher, logger } = await harness(t, { sessions: [A, B], sync: async () => { throw new Error('offline'); } });

  assert.equal((await switcher.switchTo('u-b')).userId, 'u-b');
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(logger.warnings.some((line) => line.includes('offline')), logger.warnings.join('\n'));
});
