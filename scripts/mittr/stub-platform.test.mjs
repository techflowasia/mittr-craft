import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import { availableSkills, createStubPlatform, decideReply, defaultAccounts } from './stub-platform.mjs';

const start = async (shape = 'develop') => {
  const platform = createStubPlatform({ accounts: defaultAccounts({ connectorCommand: ['node', 'stub-mcp-server.mjs'] }), shape });
  const port = await platform.listen(0);
  const base = `http://127.0.0.1:${port}`;
  return { platform, base };
};

const signIn = async (base, account) => {
  const verifier = crypto.randomBytes(32).toString('hex');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const redirectUri = 'mittrcraft-dev://auth/callback';
  const started = await fetch(`${base}/auth/desktop/start?code_challenge=${challenge}&redirect_uri=${encodeURIComponent(redirectUri)}&account=${account}`, { redirect: 'manual' });
  assert.equal(started.status, 302);
  const code = new URL(started.headers.get('location')).searchParams.get('code');
  const exchanged = await fetch(`${base}/auth/desktop/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: redirectUri }),
  });
  assert.equal(exchanged.status, 200);
  return exchanged.json();
};

const get = (base, session, route) => fetch(`${base}${route}`, { headers: { authorization: `Bearer ${session.accessToken}` } }).then((r) => r.json());

test('it listens on loopback only and refuses a code with the wrong verifier', async () => {
  const { platform, base } = await start();
  try {
    assert.equal(platform.server.address().address, '127.0.0.1');
    const started = await fetch(`${base}/auth/desktop/start?code_challenge=abc&redirect_uri=${encodeURIComponent('mittrcraft-dev://auth/callback')}`, { redirect: 'manual' });
    const code = new URL(started.headers.get('location')).searchParams.get('code');
    const exchanged = await fetch(`${base}/auth/desktop/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: 'wrong', redirect_uri: 'mittrcraft-dev://auth/callback' }),
    });
    assert.equal(exchanged.status, 400);
  } finally {
    await platform.close();
  }
});

test('each account gets its own catalog and work, and requests are counted per path', async () => {
  const { platform, base } = await start();
  try {
    const sa = await signIn(base, 'SA');
    const sb = await signIn(base, 'SB');
    assert.equal(sa.subject.userId, 'stub-user-sa');
    const saCatalog = await get(base, sa, '/desktop/catalog');
    const sbCatalog = await get(base, sb, '/desktop/catalog');
    assert.deepEqual(saCatalog.skills.map((s) => s.name), ['card-analysis']);
    assert.deepEqual(saCatalog.mcp.map((m) => m.name), ['stub-law']);
    assert.deepEqual(sbCatalog.skills.map((s) => s.name), ['notes']);
    assert.deepEqual(sbCatalog.mcp, []);
    const saWork = await get(base, sa, '/desktop/work');
    assert.deepEqual(saWork.items.map((i) => i.key), ['MRKB-1', 'TF-7', 'MIT-3']);
    assert.equal((await get(base, sb, '/desktop/work')).items.length, 1);
    platform.control({ withdrawSkill: 'SA:card-analysis' });
    assert.deepEqual((await get(base, sa, '/desktop/catalog')).skills, []);
    assert.equal(platform.snapshot().counts['GET /desktop/catalog'], 3);
    assert.equal(platform.snapshot().counts['POST /auth/desktop/exchange'], 2);
    const refreshed = await fetch(`${base}/auth/desktop/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: sa.refreshToken }) });
    assert.equal(refreshed.status, 200);
    const again = await fetch(`${base}/auth/desktop/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: sa.refreshToken }) });
    assert.equal(again.status, 401);
  } finally {
    await platform.close();
  }
});

test('integrations answer workspaceSlugs only in the develop shape', async () => {
  for (const shape of ['develop', 'main']) {
    const { platform, base } = await start(shape);
    try {
      const sa = await signIn(base, 'SA');
      const put = await fetch(`${base}/api/integrations`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${sa.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ plane: { baseUrl: 'https://plane.invalid', workspaceSlug: 'techflow', workspaceSlugs: ['techflow', 'mittr'], apiKey: 'k' } }),
      }).then((r) => r.json());
      if (shape === 'develop') assert.deepEqual(put.plane.workspaceSlugs, ['techflow', 'mittr']);
      else assert.equal('workspaceSlugs' in put.plane, false);
      const tested = await fetch(`${base}/api/integrations/plane/test`, { method: 'POST', headers: { authorization: `Bearer ${sa.accessToken}` } }).then((r) => r.json());
      assert.equal(tested.ok, true);
      assert.equal(Array.isArray(tested.workspaces), shape === 'develop');
      assert.equal(platform.snapshot().puts.length, 1);
    } finally {
      await platform.close();
    }
  }
});

test('a catalog read for one account can be held back', async () => {
  const { platform, base } = await start();
  try {
    const sb = await signIn(base, 'SB');
    platform.control({ catalogDelayMs: { SB: 150 } });
    const began = Date.now();
    await get(base, sb, '/desktop/catalog');
    assert.ok(Date.now() - began >= 140);
  } finally {
    await platform.close();
  }
});

test('short-lived access tokens and a refused refresh can be asked for', async () => {
  const { platform, base } = await start();
  try {
    platform.control({ accessTtlMs: 0, refreshRefused: true });
    const sa = await signIn(base, 'SA');
    assert.ok(sa.expiresAt <= Date.now());
    const refused = await fetch(`${base}/auth/desktop/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: sa.refreshToken }) });
    assert.equal(refused.status, 401);
  } finally {
    await platform.close();
  }
});

test('the quota marks every agent out on request', async () => {
  const { platform, base } = await start();
  try {
    const sa = await signIn(base, 'SA');
    assert.equal((await get(base, sa, '/api/quota/me')).agentStatus['stub-sa-fast'].state, 'ok');
    platform.control({ quotaOut: { SA: true } });
    const quota = await get(base, sa, '/api/quota/me');
    assert.deepEqual(Object.values(quota.agentStatus).map((s) => s.state), ['out', 'out']);
  } finally {
    await platform.close();
  }
});

test('the stub model calls the connector through execute and answers with its result', () => {
  const system = 'Code Mode: tools["mittr-stub-law"].lookup({ query?: string }) <available_skills><skill><name>mittr-card-analysis</name></skill></available_skills>';
  const tools = [{ type: 'function', function: { name: 'execute', parameters: {} } }];
  const call = decideReply({ messages: [{ role: 'system', content: system }, { role: 'user', content: 'run lookup' }], tools }, { alias: 'a' });
  assert.equal(call.kind, 'tool');
  assert.equal(call.name, 'execute');
  assert.match(call.arguments.code, /tools\["mittr-stub-law"\]\.lookup/);
  const answer = decideReply({ messages: [{ role: 'user', content: 'run lookup' }, { role: 'tool', content: 'stub-law-41' }], tools }, { alias: 'a' });
  assert.deepEqual(answer, { kind: 'text', text: 'Stub answer from a: stub-law-41' });
  assert.deepEqual(availableSkills(system), ['mittr-card-analysis']);
});

test('a chat completion streams an answer for the bearer account', async () => {
  const { platform, base } = await start();
  try {
    const sa = await signIn(base, 'SA');
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sa.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-sa-fast', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const text = await response.text();
    assert.match(text, /Stub answer from stub-sa-fast\./);
    assert.equal(platform.snapshot().counts['POST /v1/chat/completions'], 1);
    const refused = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{}' });
    assert.equal(refused.status, 401);
  } finally {
    await platform.close();
  }
});
