import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { activeAccountHome } from '../accounts.js';
import { ENGINE_DB_RULE, NO_ACCOUNT_HOME, engineBases, engineEnv, sharedHistoryExists } from '../engine-home.js';
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

const harness = async (t, { sharedHistory = false, legacy = null, sessions = [], exchanges = [], fetchImpl = null, sync = async () => {}, cacheResults = [] } = {}) => {
  const root = tempDataDir(t);
  const dataDir = path.join(root, 'data');
  const bases = engineBases({ homeDir: root, env: { MITTRCRAFT_ENGINE_HOME: path.join(root, 'engine') } });
  if (sharedHistory) {
    fs.mkdirSync(path.join(bases.data, 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(bases.data, 'opencode', 'opencode.db'), 'sessions');
  }
  if (legacy) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'mittr-session'), encrypt(JSON.stringify(legacy)));
  }
  const store = createAccountStore({ dataDir, encrypt, decrypt, sharedHistoryExists: () => sharedHistoryExists(bases) });
  sessions.forEach((session, index) => store.write(session, { activate: index === 0 }));

  const refreshes = [];
  const events = [];
  const applied = [];
  const syncs = [];
  const switches = [];
  const signIns = [];
  const logger = quietLogger();
  const engineEnvNow = () => engineEnv({ bases, accountHome: store.engineHome({ carryLegacy: false }), rule: ENGINE_DB_RULE });
  const engine = { launched: null, joins: 0, failures: 0 };
  const opencode = {
    refresh: async (reason) => {
      refreshes.push(reason);
      events.push('refresh');
      if (engine.failures > 0) {
        engine.failures -= 1;
        throw new Error('engine did not come back');
      }
      if (engine.joins > 0) {
        engine.joins -= 1;
        return;
      }
      engine.launched = engineEnvNow().XDG_DATA_HOME;
    },
    launchedDataHome: () => engine.launched,
  };
  const switcher = createAccountSwitcher({
    store,
    opencode,
    applyCache: async () => {
      applied.push(store.activeHome());
      events.push(`apply:${store.engineHome()}`);
      const result = cacheResults.shift();
      if (result instanceof Error) throw result;
      return result ?? true;
    },
    sync: () => {
      syncs.push(store.read()?.subject.userId ?? null);
      return sync();
    },
    engineDataHome: (accountHome) => engineEnv({ bases, accountHome, rule: ENGINE_DB_RULE }).XDG_DATA_HOME,
    logger,
  });
  engine.launched = engineEnvNow().XDG_DATA_HOME;

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
      return switcher.afterSignIn();
    },
    onAccountChange: (next) => {
      switches.push(next);
      return switcher.switchTo(next);
    },
    switchSettled: () => switcher.settledOnTarget(),
    logger,
  });
  return { auth, store, switcher, engine, bases, dataDir, refreshes, events, applied, syncs, switches, signIns, logger, engineEnvNow, call: await serve(t, app) };
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
  const { switcher, events, syncs } = await harness(t, { sessions: [A, B], sync: () => never.promise });

  assert.equal((await switcher.switchTo('u-b')).userId, 'u-b');

  assert.deepEqual(events, [`apply:${homeOf('u-b')}`, 'refresh']);
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

test('with nobody signed in the engine runs on an empty home of its own, and a first sign-in moves it to the account\'s', async (t) => {
  const { call, refreshes, switches, bases, engine } = await harness(t, { exchanges: [A] });
  assert.equal(engine.launched, path.join(bases.data, 'accounts', NO_ACCOUNT_HOME));

  assert.equal((await signIn(call)).status, 200);

  assert.deepEqual(switches, ['u-a']);
  assert.deepEqual(refreshes, [SWITCHED]);
  assert.equal(engine.launched, bases.data);
});

test('a 1.x session waiting to be carried keeps the shared home, and carrying it does not restart the engine', async (t) => {
  const { switcher, store, refreshes, bases, engine } = await harness(t, { legacy: A });
  assert.equal(engine.launched, bases.data);

  assert.equal((await switcher.switchTo('u-a')).userId, 'u-a');

  assert.equal(store.activeHome(), null);
  assert.deepEqual(refreshes, []);
  assert.equal(engine.launched, bases.data);
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
  assert.deepEqual(refreshes, [SWITCHED]);
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

test('a refused refresh of the active account puts the engine on the neutral home and switches to nobody', async (t) => {
  const fetchImpl = fakeFetch((request) => (request.url.endsWith('/auth/desktop/refresh') ? new Response(null, { status: 401 }) : json({})));
  const expiringA = sessionFor('u-a', 'A', { expiresAt: NOW + 30_000 });
  const { auth, store, switcher, switches, refreshes, bases, engine } = await harness(t, { sessions: [expiringA, B], fetchImpl });
  assert.equal(store.read().subject.userId, 'u-a');

  assert.equal(await auth.ensureFreshSession(), null);
  await switcher.correctEngineHome();

  assert.deepEqual(switches, [null]);
  assert.equal(store.read(), null);
  assert.deepEqual(store.list(), [{ userId: 'u-b', displayName: 'B', active: false }]);
  assert.equal(engine.launched, path.join(bases.data, 'accounts', NO_ACCOUNT_HOME));
  assert.deepEqual(refreshes, [SWITCHED]);
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
  assert.equal(engineEnvNow().XDG_DATA_HOME, path.join(bases.data, 'accounts', NO_ACCOUNT_HOME));
  assert.deepEqual(await switcher.switchTo(null), { signedIn: false });
  assert.deepEqual(refreshes, [SWITCHED]);
});

test('switching to none leaves every account signed in and none active, on the empty home', async (t) => {
  const { switcher, store, refreshes, bases, engine } = await harness(t, { sessions: [A, B] });
  await switcher.switchTo('u-b');

  assert.deepEqual(await switcher.switchTo(null), { signedIn: false });

  assert.deepEqual(store.list().map(({ userId, active }) => [userId, active]), [['u-a', false], ['u-b', false]]);
  assert.deepEqual(refreshes, [SWITCHED, SWITCHED]);
  assert.equal(engine.launched, path.join(bases.data, 'accounts', NO_ACCOUNT_HOME));
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

test('a refresh that joins a restart still on the old home is followed by one more, ending on the target', async (t) => {
  const { switcher, engine, refreshes, bases } = await harness(t, { sessions: [A, B] });
  engine.joins = 1;

  assert.deepEqual(await switcher.switchTo('u-b'), { signedIn: true, userId: 'u-b', displayName: 'B' });

  assert.deepEqual(refreshes, [SWITCHED, SWITCHED]);
  assert.equal(engine.launched, path.join(bases.data, 'accounts', homeOf('u-b')));
  assert.equal(switcher.engineOnTarget(), true);
});

test('an engine that stays on the old home after two restarts is reported, and stays closed', async (t) => {
  const { switcher, engine, refreshes, bases, logger } = await harness(t, { sessions: [A, B] });
  engine.joins = 2;

  assert.deepEqual(await switcher.switchTo('u-b'), { signedIn: true, userId: 'u-b', displayName: 'B', engineRestarted: false });

  assert.deepEqual(refreshes, [SWITCHED, SWITCHED]);
  assert.equal(engine.launched, bases.data);
  assert.equal(switcher.engineOnTarget(), false);
  assert.ok(logger.warnings.some((line) => line.includes('still on another account')), logger.warnings.join('\n'));
});

test('a restart that fails is logged and answered with engineRestarted false, and the next switch tries again', async (t) => {
  const { switcher, engine, refreshes, logger, call } = await harness(t, { sessions: [A, B] });
  engine.failures = 2;

  assert.deepEqual(await switcher.switchTo('u-b'), { signedIn: true, userId: 'u-b', displayName: 'B', engineRestarted: false });
  assert.ok(logger.warnings.some((line) => line.includes('engine did not come back')), logger.warnings.join('\n'));

  assert.deepEqual(await call('POST', '/api/mittr/auth/accounts/activate', { userId: 'u-a' }), { status: 200, body: { signedIn: true, userId: 'u-a', displayName: 'A' } });
  assert.deepEqual(refreshes, [SWITCHED]);

  assert.deepEqual((await call('DELETE', '/api/mittr/auth/session')).body, { signedIn: true, userId: 'u-b', displayName: 'B', engineRestarted: false });
  assert.deepEqual(refreshes, [SWITCHED, SWITCHED]);

  assert.deepEqual(await switcher.switchTo('u-b'), { signedIn: true, userId: 'u-b', displayName: 'B' });
  assert.deepEqual(refreshes, [SWITCHED, SWITCHED, SWITCHED]);
});

test('a correction after a ready on the wrong home restarts once, and only once for the same target', async (t) => {
  const { switcher, engine, store, refreshes, bases, logger } = await harness(t, { sessions: [A, B] });
  store.activate('u-b');
  assert.equal(switcher.engineOnTarget(), false);

  engine.joins = 2;
  await switcher.correctEngineHome();
  assert.deepEqual(refreshes, [SWITCHED, SWITCHED]);
  assert.equal(engine.launched, bases.data);

  await switcher.correctEngineHome();
  assert.deepEqual(refreshes, [SWITCHED, SWITCHED]);
  assert.ok(logger.warnings.some((line) => line.includes('came up on another account')), logger.warnings.join('\n'));

  await switcher.switchTo('u-b');
  assert.equal(engine.launched, path.join(bases.data, 'accounts', homeOf('u-b')));
});

test('a sync that fails after a switch is logged, not thrown', async (t) => {
  const { switcher, logger } = await harness(t, { sessions: [A, B], sync: async () => { throw new Error('offline'); } });

  assert.equal((await switcher.switchTo('u-b')).userId, 'u-b');
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(logger.warnings.some((line) => line.includes('offline')), logger.warnings.join('\n'));
});

test('a retry after a restart that failed brings the engine onto the active account', async (t) => {
  const { call, switcher, engine, refreshes, bases, switches } = await harness(t, { sessions: [A, B] });
  engine.failures = 1;

  assert.deepEqual((await call('POST', '/api/mittr/auth/accounts/activate', { userId: 'u-b' })).body, { signedIn: true, userId: 'u-b', displayName: 'B', engineRestarted: false });
  assert.equal(switcher.engineOnTarget(), false);

  assert.deepEqual(await call('POST', '/api/mittr/auth/accounts/retry-switch'), { status: 200, body: { signedIn: true, userId: 'u-b', displayName: 'B' } });
  assert.deepEqual(switches, ['u-b', 'u-b']);
  assert.deepEqual(refreshes, [SWITCHED, SWITCHED]);
  assert.equal(engine.launched, path.join(bases.data, 'accounts', homeOf('u-b')));

  assert.deepEqual((await call('POST', '/api/mittr/auth/accounts/retry-switch')).body, { signedIn: true, userId: 'u-b', displayName: 'B' });
  assert.deepEqual(refreshes, [SWITCHED, SWITCHED]);
  assert.deepEqual(switches, ['u-b', 'u-b']);
});

test('a retry after signing out of the last account brings the engine onto the empty home', async (t) => {
  const { call, switcher, engine, refreshes, bases } = await harness(t, { sharedHistory: true, sessions: [A] });
  engine.failures = 1;

  assert.deepEqual((await call('DELETE', '/api/mittr/auth/session')).body, { signedIn: false, engineRestarted: false });
  assert.equal(switcher.engineOnTarget(), false);

  assert.deepEqual((await call('POST', '/api/mittr/auth/accounts/retry-switch')).body, { signedIn: false });
  assert.deepEqual(refreshes, [SWITCHED, SWITCHED]);
  assert.equal(engine.launched, path.join(bases.data, 'accounts', NO_ACCOUNT_HOME));
});

test('a retry after a switch that threw runs the switch again, though the engine is already on the account\'s home', async (t) => {
  const { call, switcher, applied, switches, refreshes } = await harness(t, { sessions: [A, B], cacheResults: [new Error('cache unreadable')] });

  await assert.rejects(switcher.switchTo('u-a'), /cache unreadable/);
  assert.equal(switcher.engineOnTarget(), true);
  assert.equal(switcher.settledOnTarget(), false);

  assert.deepEqual((await call('POST', '/api/mittr/auth/accounts/retry-switch')).body, { signedIn: true, userId: 'u-a', displayName: 'A' });
  assert.deepEqual(switches, ['u-a']);
  assert.equal(applied.length, 2);
  assert.equal(switcher.settledOnTarget(), true);

  assert.deepEqual((await call('POST', '/api/mittr/auth/accounts/retry-switch')).body, { signedIn: true, userId: 'u-a', displayName: 'A' });
  assert.deepEqual(switches, ['u-a']);
  assert.deepEqual(refreshes, []);
});

test('a switch whose models could not be applied is not settled, so a retry applies them again', async (t) => {
  const { call, switcher, applied, switches } = await harness(t, { sessions: [A, B], cacheResults: [false] });

  assert.deepEqual(await switcher.switchTo('u-a'), { signedIn: true, userId: 'u-a', displayName: 'A' });
  assert.equal(switcher.settledOnTarget(), false);

  await call('POST', '/api/mittr/auth/accounts/retry-switch');
  assert.deepEqual(switches, ['u-a']);
  assert.equal(applied.length, 2);
  assert.equal(switcher.settledOnTarget(), true);
});
