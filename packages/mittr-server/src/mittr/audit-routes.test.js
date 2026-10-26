import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { AUDIT_FIELDS } from './audit-serializer.js';
import { registerMittrAuditRoutes } from './audit-routes.js';
import { deferred, fakeFetch, listen } from './test-helpers.js';

const BROKER = { baseUrl: 'https://api-dev.mittr.asia', upstreamV1: 'https://api-dev.mittr.asia/v1' };
const SESSION = { accessToken: 'at-1', subject: { userId: 'u-a' } };
const REMOTE = 'git@github.com:techflowasia/mittr-craft.git';

const recordingLogger = () => {
  const warnings = [];
  return { warnings, log: () => {}, warn: (...args) => warnings.push(args.join(' ')), error: (...args) => warnings.push(args.join(' ')) };
};

const setUp = async (t, {
  fetchImpl = fakeFetch(() => new Response(null, { status: 204 })),
  ensureFreshSession = async () => SESSION,
  remoteUrl = async () => REMOTE,
  git = { remoteUrl },
  active = { userId: 'u-a' },
  activeUserId = () => active.userId,
  remoteTimeoutMs,
} = {}) => {
  const app = express();
  const logger = recordingLogger();
  const audit = registerMittrAuditRoutes(app, { express, broker: BROKER, ensureFreshSession, activeUserId, git, fetchImpl, logger, remoteTimeoutMs });
  const base = await listen(t, app);
  const send = async (route, text) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
    return { status: response.status, text: await response.text() };
  };
  const post = (route, body) => send(route, JSON.stringify(body));
  return { audit, fetchImpl, logger, post, send, base, active };
};

const finish = (post, body = {}) => post('/api/mittr/audit/finish', { sessionId: 's1', outcome: 'completed', directory: '/repo', ...body });
const begin = (post, sessionId = 's1') => post('/api/mittr/audit/tool', { sessionId, name: 'edit' });
const sent = (fetchImpl, at = 0) => fetchImpl.calls[at].body;
const rawOf = (fetchImpl, at = 0) => JSON.stringify(fetchImpl.calls[at].body);

test('a full record reaches the platform with only the audit fields', async (t) => {
  const { post, fetchImpl } = await setUp(t);
  assert.equal((await post('/api/mittr/audit/prompt', { sessionId: 's1', text: 'fix the build' })).status, 204);
  assert.equal((await post('/api/mittr/audit/tool', { sessionId: 's1', name: 'bash' })).status, 204);
  assert.equal((await post('/api/mittr/audit/tool', { sessionId: 's1', name: 'bash' })).status, 204);
  assert.equal((await post('/api/mittr/audit/turn', { sessionId: 's1', tokens: 1200 })).status, 204);
  assert.equal(fetchImpl.calls.length, 0, 'nothing is sent before the session finishes');

  assert.equal((await finish(post, { model: 'pm_9f2c1d4e7b' })).status, 204);

  assert.equal(fetchImpl.calls.length, 1);
  const [call] = fetchImpl.calls;
  assert.equal(call.url, 'https://api-dev.mittr.asia/desktop/audit');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.authorization, 'Bearer at-1');
  assert.equal(call.headers['content-type'], 'application/json');
  const body = sent(fetchImpl);
  assert.deepEqual(Object.keys(body), [...AUDIT_FIELDS]);
  assert.equal(body.repository, 'techflowasia/mittr-craft');
  assert.deepEqual(body.actions, [{ tool: 'bash', count: 2 }]);
  assert.equal(body.prompts[0].text, 'fix the build');
  assert.equal(body.model, 'pm_9f2c1d4e7b');
  assert.equal(body.turns, 1);
  assert.equal(body.tokens, 1200);
  assert.equal(body.outcome, 'completed');
});

test('prompts are cut at 4000 characters', async (t) => {
  const { post, fetchImpl } = await setUp(t);
  await post('/api/mittr/audit/prompt', { sessionId: 's1', text: 'x'.repeat(5000) });
  await finish(post);
  assert.equal(sent(fetchImpl).prompts[0].text.length, 4000);
});

test('a prompt up to 256kb is accepted and one beyond it is refused', async (t) => {
  const { post, fetchImpl } = await setUp(t);
  assert.equal((await post('/api/mittr/audit/prompt', { sessionId: 's1', text: 'y'.repeat(200 * 1024) })).status, 204);
  const refused = await post('/api/mittr/audit/prompt', { sessionId: 's1', text: 'y'.repeat(300 * 1024) });
  assert.equal(refused.status, 413);
  assert.equal(refused.text.includes('yyyy'), false);
  await finish(post);
  assert.equal(sent(fetchImpl).prompts.length, 1);
});

test('the other routes take 8kb at most', async (t) => {
  const { post } = await setUp(t);
  assert.equal((await post('/api/mittr/audit/tool', { sessionId: 's1', name: 'z'.repeat(20 * 1024) })).status, 413);
  assert.equal((await post('/api/mittr/audit/turn', { sessionId: 's1', tokens: 1, pad: 'z'.repeat(20 * 1024) })).status, 413);
  assert.equal((await finish(post, { pad: 'z'.repeat(20 * 1024) })).status, 413);
});

test('a body that is not JSON is refused without echoing it', async (t) => {
  const { send, fetchImpl } = await setUp(t);
  const refused = await send('/api/mittr/audit/prompt', '{"text": "secret prompt');
  assert.equal(refused.status, 400);
  assert.equal(refused.text.includes('secret prompt'), false);
  assert.equal(fetchImpl.calls.length, 0);
});

test('the 201st open record drops the oldest', async (t) => {
  const { post, fetchImpl } = await setUp(t);
  for (let i = 0; i <= 200; i += 1) await post('/api/mittr/audit/prompt', { sessionId: `s${i}`, text: `p${i}` });

  await finish(post, { sessionId: 's1' });
  assert.deepEqual(sent(fetchImpl, 0).prompts.map(({ text }) => text), ['p1']);
  await finish(post, { sessionId: 's0' });
  assert.equal(fetchImpl.calls.length, 1, 'the evicted session has no record left to send');
});

test('signed out sends nothing and still answers 204', async (t) => {
  const { post, fetchImpl } = await setUp(t, { ensureFreshSession: async () => null });
  await post('/api/mittr/audit/prompt', { sessionId: 's1', text: 'hello' });
  assert.equal((await finish(post)).status, 204);
  assert.equal(fetchImpl.calls.length, 0);
});

test('a session without an access token sends nothing either', async (t) => {
  const { post, fetchImpl } = await setUp(t, { ensureFreshSession: async () => ({ subject: { userId: 'u-a' } }) });
  assert.equal((await finish(post)).status, 204);
  assert.equal(fetchImpl.calls.length, 0);
});

test('one record is sent on finish, and the session is forgotten after it', async (t) => {
  const { post, fetchImpl } = await setUp(t);
  await post('/api/mittr/audit/prompt', { sessionId: 's1', text: 'once' });
  await finish(post);
  await finish(post);
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(sent(fetchImpl).prompts.map(({ text }) => text), ['once']);
});

test('turns and tokens are summed, and a token count that is not a number counts as zero', async (t) => {
  const { post, fetchImpl } = await setUp(t);
  await post('/api/mittr/audit/turn', { sessionId: 's1', tokens: 1200 });
  await post('/api/mittr/audit/turn', { sessionId: 's1', tokens: 800 });
  await post('/api/mittr/audit/turn', { sessionId: 's1', tokens: 'lots' });
  await finish(post);
  const body = sent(fetchImpl);
  assert.equal(body.turns, 3);
  assert.equal(body.tokens, 2000);
});

test('sessions are kept apart', async (t) => {
  const { post, fetchImpl } = await setUp(t);
  await post('/api/mittr/audit/prompt', { sessionId: 's1', text: 'one' });
  await post('/api/mittr/audit/prompt', { sessionId: 's2', text: 'two' });
  await finish(post, { sessionId: 's1' });
  assert.deepEqual(sent(fetchImpl).prompts.map(({ text }) => text), ['one']);
});

test('a tool use keeps its name only, and an empty prompt or name is ignored', async (t) => {
  const { post, fetchImpl } = await setUp(t);
  await post('/api/mittr/audit/tool', { sessionId: 's1', name: 'edit', args: { path: '/Users/someone/client-secret/file.ts' }, command: 'rm -rf /' });
  await post('/api/mittr/audit/tool', { sessionId: 's1', name: '' });
  await post('/api/mittr/audit/prompt', { sessionId: 's1', text: '' });
  await finish(post);
  const body = sent(fetchImpl);
  assert.deepEqual(body.actions, [{ tool: 'edit', count: 1 }]);
  assert.deepEqual(body.prompts, []);
  assert.equal(rawOf(fetchImpl).includes('client-secret'), false);
  assert.equal(rawOf(fetchImpl).includes('rm -rf'), false);
});

test('nothing the client adds outside the allowlist is sent, and neither is who it says it is', async (t) => {
  const { post, fetchImpl } = await setUp(t);
  await post('/api/mittr/audit/prompt', { sessionId: 's1', text: 'hi' });
  await finish(post, { fileContents: 'const secret = 1;', userId: 'somebody-else', email: 'x@example.com' });
  const raw = rawOf(fetchImpl);
  for (const needle of ['secret', 'somebody-else', 'x@example.com']) assert.equal(raw.includes(needle), false, needle);
  assert.deepEqual(Object.keys(sent(fetchImpl)), [...AUDIT_FIELDS]);
});

test('the local directory is used to find the remote and never sent', async (t) => {
  const asked = [];
  const { post, fetchImpl } = await setUp(t, { remoteUrl: async (directory) => { asked.push(directory); return REMOTE; } });
  await begin(post);
  await finish(post, { directory: '/Users/someone/client-secret' });
  assert.deepEqual(asked, ['/Users/someone/client-secret']);
  assert.equal(rawOf(fetchImpl).includes('client-secret'), false);
  assert.equal(rawOf(fetchImpl).includes('/Users'), false);
});

test('a remote with credentials in it sends the owner and repository only, and logs nothing of it', async (t) => {
  const { post, fetchImpl, logger } = await setUp(t, { remoteUrl: async () => 'https://person:s3cret-token@github.com/techflowasia/mittr-craft.git' });
  await begin(post);
  await finish(post);
  assert.equal(sent(fetchImpl).repository, 'techflowasia/mittr-craft');
  assert.equal(rawOf(fetchImpl).includes('s3cret'), false);
  assert.equal(JSON.stringify(fetchImpl.calls[0].headers).includes('s3cret'), false);
  assert.equal(logger.warnings.join('\n').includes('s3cret'), false);
});

test('a directory with no remote, or one git cannot read, is sent as no repository', async (t) => {
  const none = await setUp(t, { remoteUrl: async () => null });
  await begin(none.post);
  await finish(none.post);
  assert.equal(sent(none.fetchImpl).repository, null);

  const broken = await setUp(t, { remoteUrl: async () => { throw new Error('not a repository'); } });
  await begin(broken.post);
  await finish(broken.post);
  assert.equal(sent(broken.fetchImpl).repository, null);
  assert.deepEqual(broken.logger.warnings, []);
});

test('the platform call has a time limit', async (t) => {
  const { post, fetchImpl } = await setUp(t);
  await begin(post);
  await finish(post);
  assert.ok(fetchImpl.calls[0].signal);
});

test('a platform that refuses the record only costs a warning', async (t) => {
  const { post, logger } = await setUp(t, { fetchImpl: fakeFetch(() => new Response('', { status: 500 })) });
  await begin(post);
  assert.equal((await finish(post)).status, 204);
  assert.equal(logger.warnings.length, 1);
  assert.ok(logger.warnings[0].includes('500'), logger.warnings[0]);
});

test('a platform that cannot be reached only costs a warning', async (t) => {
  const { post, logger } = await setUp(t, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await begin(post);
  assert.equal((await finish(post)).status, 204);
  assert.deepEqual(logger.warnings, ['[mittr] audit record was not delivered: ECONNREFUSED']);
});

test('a session refresh that throws still answers 204', async (t) => {
  const { post, fetchImpl, logger } = await setUp(t, { ensureFreshSession: async () => { throw new Error('keychain locked'); } });
  await begin(post);
  assert.equal((await finish(post)).status, 204);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(logger.warnings.length, 1);
});

test('records open when the account changes are never sent', async (t) => {
  const { post, fetchImpl, audit } = await setUp(t);
  await post('/api/mittr/audit/prompt', { sessionId: 's1', text: 'typed as the first account' });
  await post('/api/mittr/audit/tool', { sessionId: 's1', name: 'edit' });
  audit.clear();
  assert.equal((await finish(post)).status, 204);
  assert.equal(fetchImpl.calls.length, 0);
});

test('a finish that arrives late for a cleared session sends nothing, not a new record under the account now active', async (t) => {
  const { post, fetchImpl, audit } = await setUp(t);
  await post('/api/mittr/audit/prompt', { sessionId: 's1', text: 'typed as the first account' });
  audit.clear();
  assert.equal((await finish(post, { model: 'pm_first', directory: '/repo' })).status, 204);
  assert.equal(fetchImpl.calls.length, 0);
});

test('a prompt, tool or turn that arrives late for a cleared session opens nothing', async (t) => {
  const { post, fetchImpl, audit } = await setUp(t);
  await post('/api/mittr/audit/prompt', { sessionId: 's1', text: 'typed as the first account' });
  audit.clear();
  assert.equal((await post('/api/mittr/audit/prompt', { sessionId: 's1', text: 'late prompt' })).status, 204);
  assert.equal((await post('/api/mittr/audit/tool', { sessionId: 's1', name: 'edit' })).status, 204);
  assert.equal((await post('/api/mittr/audit/turn', { sessionId: 's1', tokens: 5 })).status, 204);
  assert.equal((await finish(post)).status, 204);
  assert.equal(fetchImpl.calls.length, 0);
});

test('a session opened fresh after the account changed is sent as the account now active', async (t) => {
  const { post, fetchImpl, audit, active } = await setUp(t, { ensureFreshSession: async () => ({ accessToken: `at-${active.userId}`, subject: { userId: active.userId } }) });
  await post('/api/mittr/audit/prompt', { sessionId: 's1', text: 'typed as the first account' });
  active.userId = 'u-b';
  audit.clear();
  await post('/api/mittr/audit/prompt', { sessionId: 's2', text: 'typed as the second account' });
  await finish(post, { sessionId: 's1' });
  await finish(post, { sessionId: 's2' });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].headers.authorization, 'Bearer at-u-b');
  assert.deepEqual(sent(fetchImpl).prompts.map(({ text }) => text), ['typed as the second account']);
});

test('the sessions a clear forgot are remembered up to a bound, oldest first', async (t) => {
  const { post, fetchImpl, audit } = await setUp(t);
  for (let round = 0; round < 6; round += 1) {
    for (let i = 0; i < 200; i += 1) await post('/api/mittr/audit/tool', { sessionId: `r${round}-${i}`, name: 'edit' });
    audit.clear();
  }
  await post('/api/mittr/audit/tool', { sessionId: 'r5-199', name: 'edit' });
  await post('/api/mittr/audit/tool', { sessionId: 'r0-0', name: 'edit' });
  await finish(post, { sessionId: 'r5-199' });
  assert.equal(fetchImpl.calls.length, 0, 'a recently cleared session stays closed');
  await finish(post, { sessionId: 'r0-0' });
  assert.equal(fetchImpl.calls.length, 1, 'one forgotten long ago may open again');
});

test('a damaged account index gives 204 on every audit route and sends nothing', async (t) => {
  const { post, fetchImpl } = await setUp(t, { activeUserId: () => { throw new Error('index unreadable'); } });
  assert.equal((await post('/api/mittr/audit/prompt', { sessionId: 's1', text: 'hello' })).status, 204);
  assert.equal((await post('/api/mittr/audit/tool', { sessionId: 's1', name: 'edit' })).status, 204);
  assert.equal((await post('/api/mittr/audit/turn', { sessionId: 's1', tokens: 3 })).status, 204);
  assert.equal((await finish(post)).status, 204);
  assert.equal(fetchImpl.calls.length, 0);
});

test('a damaged index at finish drops the record and still answers 204', async (t) => {
  let damaged = false;
  const { post, fetchImpl } = await setUp(t, { activeUserId: () => { if (damaged) throw new Error('index unreadable'); return 'u-a'; } });
  await begin(post);
  damaged = true;
  assert.equal((await finish(post)).status, 204);
  assert.equal(fetchImpl.calls.length, 0);
});

test('a remote lookup that never answers is given up after its time limit and the record is sent with no repository', async (t) => {
  const { post, fetchImpl } = await setUp(t, { remoteUrl: () => new Promise(() => {}), remoteTimeoutMs: 20 });
  await begin(post);
  assert.equal((await finish(post)).status, 204);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(sent(fetchImpl).repository, null);
});

test('the remote lookup has a default time limit of five seconds', async (t) => {
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...rest) => { timers.push(ms); return realSetTimeout(fn, ms, ...rest); });
  const { post } = await setUp(t);
  await begin(post);
  await finish(post);
  assert.ok(timers.includes(5000), timers.join());
});

test('a finish that is waiting for its session when the account changes sends nothing', async (t) => {
  const held = deferred();
  const { post, fetchImpl, audit } = await setUp(t, { ensureFreshSession: () => held.promise });
  await post('/api/mittr/audit/prompt', { sessionId: 's1', text: 'typed as the first account' });
  const pending = finish(post);
  await new Promise((resolve) => setTimeout(resolve, 20));
  audit.clear();
  held.resolve({ accessToken: 'at-b', subject: { userId: 'u-b' } });
  assert.equal((await pending).status, 204);
  assert.equal(fetchImpl.calls.length, 0);
});

test('a record opened under one account is dropped when another is active at finish, even when nothing announced the change', async (t) => {
  const { post, fetchImpl, active } = await setUp(t, { ensureFreshSession: async () => ({ accessToken: `at-${active.userId}`, subject: { userId: active.userId } }) });
  await post('/api/mittr/audit/prompt', { sessionId: 's1', text: 'typed as the first account' });
  await post('/api/mittr/audit/tool', { sessionId: 's1', name: 'edit' });

  active.userId = 'u-b';
  assert.equal((await finish(post)).status, 204);
  assert.equal(fetchImpl.calls.length, 0, 'nothing is sent with the other account\'s token');

  active.userId = 'u-a';
  assert.equal((await finish(post)).status, 204);
  assert.equal(fetchImpl.calls.length, 0, 'the dropped record is gone, not kept for later and not rebuilt empty');
});

test('a session of another account than the record\'s owner is never used', async (t) => {
  const { post, fetchImpl } = await setUp(t, { ensureFreshSession: async () => ({ accessToken: 'at-b', subject: { userId: 'u-b' } }) });
  await post('/api/mittr/audit/prompt', { sessionId: 's1', text: 'hello' });
  assert.equal((await finish(post)).status, 204);
  assert.equal(fetchImpl.calls.length, 0);
});

test('an account that changes while the session is being fetched sends nothing', async (t) => {
  const held = deferred();
  const { post, fetchImpl, active } = await setUp(t, { ensureFreshSession: () => held.promise });
  await post('/api/mittr/audit/prompt', { sessionId: 's1', text: 'hello' });
  const pending = finish(post);
  await new Promise((resolve) => setTimeout(resolve, 20));
  active.userId = 'u-b';
  held.resolve({ accessToken: 'at-b', subject: { userId: 'u-b' } });
  assert.equal((await pending).status, 204);
  assert.equal(fetchImpl.calls.length, 0);
});

test('a record opened while nobody is signed in is never sent', async (t) => {
  const { post, fetchImpl, active } = await setUp(t, { active: { userId: null } });
  await post('/api/mittr/audit/prompt', { sessionId: 's1', text: 'typed signed out' });
  active.userId = 'u-a';
  assert.equal((await finish(post)).status, 204);
  assert.equal(fetchImpl.calls.length, 0);
});
