import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { OPENCHAMBER_ALL_ACTIONS } from '../../../../web/server/lib/openchamber-control/actions.js';
import { ENGINE_DB_RULE, engineBases, engineEnv } from '../../engine-home.js';
import { createAccountStore, keyOf } from '../account-store.js';
import { createAccountSwitcher } from '../accounts-switch.js';
import { ACCOUNT_CHANGED, PLATFORM_TIMED_OUT } from '../platform.js';
import { decrypt, deferred, encrypt, fakeFetch, json, tempDataDir } from '../test-helpers.js';
import { MITTR_TOOLS, createMittrActionRegistry } from './registry.js';
import { MAX_PLANE_LINK_CHARS, WORK_TOOL_DESCRIPTION, createWorkLookup, registerWorkActions } from './work-lookup.js';

const BROKER = { baseUrl: 'https://platform.example.test' };
const ACCESS_TOKEN = 'at-work-7f3a9c';
const SESSION = { accessToken: ACCESS_TOKEN, subject: { userId: 'u-1' } };
const KEY_1 = keyOf('u-1');
const KEY_2 = keyOf('u-2');
const AGENT = { surface: 'agent', tool: MITTR_TOOLS.work };

const ISSUE = { key: 'MRKB-2122', summary: 'Pay with PromptPay', description: 'Show the QR code', statusName: 'In Progress', priorityName: 'High', issueType: 'Story', assigneeEmail: 'somchai@acme.example.test', url: 'https://acme.example.test/browse/MRKB-2122' };
const PLANE_ISSUE = { id: 'w1', key: 'MITRAI-12', name: 'Create Evals', description: 'Write them', stateName: 'Todo', priority: 'high', targetDate: '2026-11-01', updatedAt: null, project: 'Mittr AI', workspace: 'mittr', url: 'https://plane.example.test/mittr/projects/p/issues/w1' };

const recordingLogger = () => {
  const lines = [];
  const record = (...args) => lines.push(args.join(' '));
  return { lines, log: record, warn: record, error: record };
};

const worker = (respond, { session = SESSION, onActiveHome = () => true, accountKey = () => KEY_1, refresh, ...options } = {}) => {
  const fetchImpl = fakeFetch(respond);
  const registry = createMittrActionRegistry({ control: { all: OPENCHAMBER_ALL_ACTIONS, execute: async () => ({}) } });
  registerWorkActions(registry, {
    broker: BROKER,
    ensureFreshSession: async () => {
      await refresh?.();
      return session instanceof Function ? session() : session;
    },
    fetchImpl,
    engineOnActiveHome: () => onActiveHome(),
    activeAccountKey: () => accountKey(),
    ...options,
  });
  const run = (action, input, ctx = {}) => registry.execute(action, input, { ...AGENT, ...ctx });
  return { run, fetchImpl, registry };
};

const refusal = (statusCode, message) => (error) => {
  assert.equal(error.message, message);
  assert.equal(error.statusCode, statusCode);
  return true;
};

test('a Jira key is read through the platform and passed through', async () => {
  const { run, fetchImpl } = worker(() => json(ISSUE));
  assert.deepEqual(await run('jira.get_issue', { key: 'MRKB-2122' }), ISSUE);
  const [call] = fetchImpl.calls;
  assert.equal(call.url, 'https://platform.example.test/desktop/jira/issues/MRKB-2122');
  assert.equal(call.method, 'GET');
  assert.deepEqual(call.headers, { authorization: `Bearer ${ACCESS_TOKEN}` });
  assert.equal(call.body, undefined);
});

test('a Jira key is trimmed and upper-cased before it is sent', async () => {
  const { run, fetchImpl } = worker(() => json(ISSUE));
  await run('jira.get_issue', { key: '  mrkb-2122 ' });
  assert.equal(fetchImpl.calls[0].url, 'https://platform.example.test/desktop/jira/issues/MRKB-2122');
});

test('a Plane link is sent as ref, encoded', async () => {
  const { run, fetchImpl } = worker(() => json(PLANE_ISSUE));
  const link = 'https://plane.example.test/mittr/projects/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b/issues/1a2b3c4d-5e6f-7081-9a2b-3c4d5e6f7081?peek=1&x=a%20b&t=%E0%B8%81#top';
  assert.deepEqual(await run('plane.get_issue', { ref: link }), PLANE_ISSUE);
  const [call] = fetchImpl.calls;
  assert.equal(call.url, `https://platform.example.test/desktop/plane/issues?ref=${encodeURIComponent(link)}`);
  assert.equal(new URL(call.url).searchParams.get('ref'), link);
  assert.equal(new URL(call.url).pathname, '/desktop/plane/issues');
  assert.equal(call.headers.authorization, `Bearer ${ACCESS_TOKEN}`);
});

test('a Plane key is sent as ref', async () => {
  const { run, fetchImpl } = worker(() => json(PLANE_ISSUE));
  await run('plane.get_issue', { ref: ' mitrai-12 ' });
  assert.equal(fetchImpl.calls[0].url, 'https://platform.example.test/desktop/plane/issues?ref=MITRAI-12');
});

test('a missing key answers 400 and calls nothing', async () => {
  const { run, fetchImpl } = worker(() => json(ISSUE));
  for (const input of [{}, { key: '' }, { key: '   ' }, { key: 7 }, { key: null }, { key: ['MRKB-1'] }]) {
    await assert.rejects(run('jira.get_issue', input), refusal(400, 'key is required for jira.get_issue'));
  }
  for (const input of [{}, { ref: '' }, { ref: '  ' }, { ref: 12 }, { ref: { href: 'x' } }]) {
    await assert.rejects(run('plane.get_issue', input), refusal(400, 'ref is required for plane.get_issue'));
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('only a Jira key or a Plane key or http(s) link reaches the platform', async () => {
  const { run, fetchImpl } = worker(() => json(ISSUE));
  for (const key of ['MRKB', '2122', 'MRKB-', 'MRKB-12a', '1RKB-12', 'A-1', '../admin', 'MRKB-1/../../x', 'MRKB-1?x=1', 'MRKB-1#f', 'MRKB 1', 'MRKB-1\nX', 'MRKB-1234567890', 'https://acme.example.test/browse/MRKB-1']) {
    await assert.rejects(run('jira.get_issue', { key }), refusal(400, 'key must be a Jira issue key such as MRKB-2122'), key);
  }
  for (const ref of ['MITRAI', '12', 'MITRAI-', 'ftp://plane.example.test/x/MITRAI-1', 'file:///etc/passwd', 'javascript:alert(1)', '//plane.example.test/x', 'plane.example.test/x/MITRAI-1', 'https://', 'https://user:pass@plane.example.test/x', 'https://plane.example.test/a b', 'https://plane.example.test/x\nHost: evil', `https://plane.example.test/${'a'.repeat(MAX_PLANE_LINK_CHARS)}`, '../MITRAI-1', 'MITRAI-1&ref=x']) {
    await assert.rejects(run('plane.get_issue', { ref }), refusal(400, 'ref must be a Plane work item link or key such as MITRAI-12'), ref);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('nothing from the input but the key or the encoded ref reaches the request', async () => {
  const { run, fetchImpl } = worker(() => json(ISSUE));
  await run('jira.get_issue', { key: 'MRKB-1', ref: 'x', url: 'https://evil.example.test', headers: { authorization: 'Bearer stolen' }, query: '?a=1' });
  await run('plane.get_issue', { ref: 'MITRAI-1', key: 'x', url: 'https://evil.example.test', headers: { authorization: 'Bearer stolen' } });
  assert.deepEqual(fetchImpl.calls.map(({ url, headers, body }) => [url, headers, body]), [
    ['https://platform.example.test/desktop/jira/issues/MRKB-1', { authorization: `Bearer ${ACCESS_TOKEN}` }, undefined],
    ['https://platform.example.test/desktop/plane/issues?ref=MITRAI-1', { authorization: `Bearer ${ACCESS_TOKEN}` }, undefined],
  ]);
});

test('a platform 404 passes its message', async () => {
  const { run } = worker(() => json({ statusCode: 404, message: 'Jira error: Issue does not exist', error: 'Not Found' }, 404));
  await assert.rejects(run('jira.get_issue', { key: 'MRKB-9' }), refusal(404, 'Jira error: Issue does not exist'));
  const planeMissing = worker(() => json({ statusCode: 404, message: 'No connected Plane workspace (mittr) holds MITRAI-99', error: 'Not Found' }, 404));
  await assert.rejects(planeMissing.run('plane.get_issue', { ref: 'MITRAI-99' }), refusal(404, 'No connected Plane workspace (mittr) holds MITRAI-99'));
});

test('a platform answer with no message names the card and keeps the platform status', async () => {
  const { run } = worker((_call, count) => (count === 1 ? json({}, 500) : new Response('not json', { status: 400 })));
  await assert.rejects(run('jira.get_issue', { key: 'MRKB-9' }), refusal(500, 'Failed to load Jira issue MRKB-9'));
  await assert.rejects(run('plane.get_issue', { ref: 'MITRAI-9' }), refusal(400, 'Failed to load Plane work item MITRAI-9'));
});

test('an answer that is ok but empty is a bad gateway', async () => {
  const { run } = worker(() => new Response('', { status: 200 }));
  await assert.rejects(run('jira.get_issue', { key: 'MRKB-9' }), refusal(502, 'The Mittr platform returned no issue'));
  for (const body of [[], 'card', 7, true, null]) {
    const odd = worker(() => json(body));
    await assert.rejects(odd.run('plane.get_issue', { ref: 'MITRAI-9' }), refusal(502, 'The Mittr platform returned no issue'), JSON.stringify(body));
  }
});

test('a session refresh that fails answers 401 sign in and calls nothing', async () => {
  const { run, fetchImpl } = worker(() => json(ISSUE), { session: () => { throw new Error('refresh token rejected: rt-secret-1'); } });
  for (const [action, input] of [['jira.get_issue', { key: 'MRKB-1' }], ['plane.get_issue', { ref: 'MITRAI-1' }]]) {
    await assert.rejects(run(action, input), refusal(401, 'Not signed in to Mittr. Sign in to continue.'));
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('a platform that does not answer in time is 504 and one that is down is 502', async () => {
  const lookupWith = (fetchImpl) => createWorkLookup({ broker: BROKER, ensureFreshSession: async () => SESSION, engineOnActiveHome: () => true, activeAccountKey: () => KEY_1, fetchImpl });
  const slow = lookupWith(async () => { throw new DOMException('slow', 'TimeoutError'); });
  await assert.rejects(slow.jiraIssue({ key: 'MRKB-1' }), refusal(504, PLATFORM_TIMED_OUT));
  const slowBody = lookupWith(async () => ({ ok: true, status: 200, json: async () => { throw new DOMException('slow', 'TimeoutError'); } }));
  await assert.rejects(slowBody.planeIssue({ ref: 'MITRAI-1' }), refusal(504, PLATFORM_TIMED_OUT));
  const down = lookupWith(async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(down.planeIssue({ ref: 'MITRAI-1' }), refusal(502, 'Cannot reach Mittr'));
});

test('no account answers 401 and calls nothing', async () => {
  for (const session of [null, () => undefined, {}, { subject: { userId: 'u-1' } }]) {
    const { run, fetchImpl } = worker(() => json(ISSUE), { session });
    await assert.rejects(run('jira.get_issue', { key: 'MRKB-1' }), refusal(401, 'Not signed in to Mittr. Sign in to continue.'));
    await assert.rejects(run('plane.get_issue', { ref: 'MITRAI-1' }), refusal(401, 'Not signed in to Mittr. Sign in to continue.'));
    assert.equal(fetchImpl.calls.length, 0);
  }
});

test('an aborted turn cancels the platform request', async () => {
  const started = deferred();
  const { run } = worker((call) => {
    started.resolve();
    return new Promise((_resolve, reject) => {
      call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true });
    });
  });
  const controller = new AbortController();
  const pending = run('jira.get_issue', { key: 'MRKB-1' }, { signal: controller.signal });
  await started.promise;
  controller.abort();
  await assert.rejects(pending, refusal(499, 'The Mittr platform request was cancelled'));
});

test('a lookup whose session changed account during the call answers 409 and returns nothing', async () => {
  const active = { key: KEY_1 };
  const { run, fetchImpl } = worker(() => json(ISSUE), { accountKey: () => active.key, refresh: async () => { active.key = KEY_2; } });
  await assert.rejects(run('jira.get_issue', { key: 'MRKB-1' }), refusal(409, ACCOUNT_CHANGED));
  assert.equal(fetchImpl.calls.length, 0);

  const answered = { key: KEY_1 };
  const afterReply = worker(() => { answered.key = KEY_2; return json(ISSUE); }, { accountKey: () => answered.key });
  await assert.rejects(afterReply.run('plane.get_issue', { ref: 'MITRAI-1' }), refusal(409, ACCOUNT_CHANGED));
  assert.equal(afterReply.fetchImpl.calls.length, 1);

  const failed = { key: KEY_1 };
  const afterError = worker(() => { failed.key = KEY_2; return json({ message: 'Jira error: HTTP 403' }, 403); }, { accountKey: () => failed.key });
  await assert.rejects(afterError.run('jira.get_issue', { key: 'MRKB-1' }), refusal(409, ACCOUNT_CHANGED));
});

test('a session of another account than the one the call began on is refused before the platform is asked', async () => {
  const { run, fetchImpl } = worker(() => json(ISSUE), { session: { accessToken: ACCESS_TOKEN, subject: { userId: 'u-2' } } });
  await assert.rejects(run('plane.get_issue', { ref: 'MITRAI-1' }), refusal(409, ACCOUNT_CHANGED));
  assert.equal(fetchImpl.calls.length, 0);
});

test('an account switch that is still being applied is refused at once and again after the call', async () => {
  const state = { settled: false };
  const { run, fetchImpl } = worker(() => json(ISSUE), { onActiveHome: () => state.settled });
  await assert.rejects(run('jira.get_issue', { key: 'MRKB-1' }), refusal(409, ACCOUNT_CHANGED));
  assert.equal(fetchImpl.calls.length, 0);
  state.settled = true;
  assert.deepEqual(await run('jira.get_issue', { key: 'MRKB-1' }), ISSUE);
  const closing = worker(() => { state.settled = false; return json(ISSUE); }, { onActiveHome: () => state.settled });
  state.settled = true;
  await assert.rejects(closing.run('jira.get_issue', { key: 'MRKB-1' }), refusal(409, ACCOUNT_CHANGED));
});

test('a signed-in first account whose engine home is not set apart is not refused, and a second account on the first one\'s engine is', async (t) => {
  const root = tempDataDir(t);
  const dataDir = path.join(root, 'data');
  const bases = engineBases({ homeDir: root, env: { MITTRCRAFT_ENGINE_HOME: path.join(root, 'engine') } });
  const store = createAccountStore({ dataDir, encrypt, decrypt, sharedHistoryExists: () => false });
  const session = (userId) => ({ accessToken: `at-${userId}`, refreshToken: `r-${userId}`, expiresAt: Date.now() + 3_600_000, subject: { userId, displayName: userId } });
  store.write(session('u-1'), { activate: true });
  assert.equal(store.engineHome({ carryLegacy: false }), null);
  const engine = { launched: engineEnv({ bases, accountHome: null, rule: ENGINE_DB_RULE }).XDG_DATA_HOME };
  const switcher = createAccountSwitcher({
    store,
    opencode: { launchedDataHome: () => engine.launched, refresh: async () => {} },
    applyCache: async () => true,
    sync: async () => {},
    engineDataHome: (accountHome) => engineEnv({ bases, accountHome, rule: ENGINE_DB_RULE }).XDG_DATA_HOME,
    logger: recordingLogger(),
  });
  const activeUserId = () => store.list({ carryLegacy: false }).find((account) => account.active)?.userId ?? null;
  const { run, fetchImpl } = worker(() => json(ISSUE), {
    session: () => session(activeUserId()),
    onActiveHome: () => switcher.engineOnTarget(),
    accountKey: () => (activeUserId() ? keyOf(activeUserId()) : null),
  });

  assert.deepEqual(await run('jira.get_issue', { key: 'MRKB-1' }), ISSUE);
  assert.equal(fetchImpl.calls.length, 1);

  store.write(session('u-2'), { activate: true });
  assert.notEqual(store.engineHome({ carryLegacy: false }), null);
  await assert.rejects(run('jira.get_issue', { key: 'MRKB-1' }), refusal(409, ACCOUNT_CHANGED));
  assert.equal(fetchImpl.calls.length, 1);
});

test('the access token appears in no reply or log line', async () => {
  const logger = recordingLogger();
  const { run, fetchImpl } = worker((_call, count) => (count < 3 ? json(ISSUE) : json({ message: 'Jira error: HTTP 403' }, 403)));
  const results = [
    await run('jira.get_issue', { key: 'MRKB-2122' }),
    await run('plane.get_issue', { ref: 'MITRAI-12' }),
  ];
  const failure = await run('jira.get_issue', { key: 'MRKB-2122' }).catch((error) => error);
  assert.equal(failure.statusCode, 403);
  assert.deepEqual(fetchImpl.calls.map(({ headers }) => headers.authorization), [`Bearer ${ACCESS_TOKEN}`, `Bearer ${ACCESS_TOKEN}`, `Bearer ${ACCESS_TOKEN}`]);
  for (const text of [JSON.stringify(results), failure.message, failure.stack, ...logger.lines]) {
    assert.equal(text.includes(ACCESS_TOKEN), false, text);
  }
  assert.equal(new URL(fetchImpl.calls[0].url).search, '');
  assert.equal(fetchImpl.calls.every(({ url }) => !url.includes(ACCESS_TOKEN)), true);
});

test('the bearer goes only to the broker', async () => {
  const { run, fetchImpl } = worker(() => json(PLANE_ISSUE));
  await run('plane.get_issue', { ref: 'https://evil.example.test/mittr/projects/x/issues/MITRAI-1' });
  await run('jira.get_issue', { key: 'MRKB-1' });
  assert.deepEqual(fetchImpl.calls.map(({ url }) => new URL(url).origin), [BROKER.baseUrl, BROKER.baseUrl]);
});

test('both actions are read actions on the work tool and the description tells the model how to use them', () => {
  const { registry } = worker(() => json(ISSUE));
  assert.deepEqual(registry.definitions({ tool: MITTR_TOOLS.work }).map(({ action, effect, available, voiceOnly }) => [action, effect, available, voiceOnly]), [
    ['jira.get_issue', 'read', true, false],
    ['plane.get_issue', 'read', true, false],
  ]);
  assert.match(WORK_TOOL_DESCRIPTION, /jira\.get_issue reads one Jira card by key \(e\.g\. MRKB-2122\)/);
  assert.match(WORK_TOOL_DESCRIPTION, /plane\.get_issue reads one Plane work item by its link or key \(e\.g\. MITRAI-12\)/);
  assert.match(WORK_TOOL_DESCRIPTION, /A Plane link is a sign-in page to a plain fetch; read it with plane\.get_issue\./);
  assert.equal(registry.tools().find(({ name }) => name === MITTR_TOOLS.work).description, WORK_TOOL_DESCRIPTION);
});

test('the actions are reachable by their full name only, since the short name is ambiguous', () => {
  const { registry } = worker(() => json(ISSUE));
  assert.deepEqual(registry.resolve('jira.get_issue', MITTR_TOOLS.work), { action: 'jira.get_issue' });
  assert.deepEqual(registry.resolve('plane.get_issue', MITTR_TOOLS.work), { action: 'plane.get_issue' });
  assert.match(registry.resolve('get_issue', MITTR_TOOLS.work).error, /Unknown action "get_issue" for mittrcraft_work; it has: jira\.get_issue, plane\.get_issue/);
});

test('without a broker, a refresh, or the account rules the actions are unavailable', async () => {
  const deps = { broker: BROKER, ensureFreshSession: async () => SESSION, engineOnActiveHome: () => true, activeAccountKey: () => KEY_1 };
  assert.ok(createWorkLookup(deps));
  for (const missing of ['ensureFreshSession', 'engineOnActiveHome', 'activeAccountKey']) {
    assert.equal(createWorkLookup({ ...deps, [missing]: undefined }), null, missing);
  }
  assert.equal(createWorkLookup({ ...deps, broker: { baseUrl: null } }), null);
  assert.equal(createWorkLookup({}), null);
  assert.equal(createWorkLookup(), null);
  const registry = createMittrActionRegistry({ control: { all: OPENCHAMBER_ALL_ACTIONS, execute: async () => ({}) } });
  registerWorkActions(registry, {});
  assert.deepEqual(registry.tools(), []);
  await assert.rejects(registry.execute('jira.get_issue', { key: 'MRKB-1' }, AGENT), refusal(503, 'Read a Jira card is not available in this install'));
});
