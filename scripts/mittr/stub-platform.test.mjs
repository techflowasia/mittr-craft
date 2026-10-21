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
      assert.equal(tested.workspaceId, 'stub-not-for-clients');
      if (shape === 'develop') assert.deepEqual(tested.workspaces[0].projects, ['stub-not-for-clients']);
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

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

const toolsNamed = (...names) => names.map((name) => ({ type: 'function', function: { name, parameters: {} } }));

test('the stub model calls the MittrCraft tools on fixed phrases', () => {
  const tools = toolsNamed('mittrcraft_chrome', 'mittrcraft_computer', 'mittrcraft_work', 'openchamber', 'openchamber_web');
  const ask = (text) => decideReply({ messages: [{ role: 'user', content: text }], tools }, { alias: 'a' });
  assert.deepEqual(ask('chrome open http://127.0.0.1:9/form'), { kind: 'tool', name: 'mittrcraft_chrome', arguments: { action: 'chrome.open', parameters: { url: 'http://127.0.0.1:9/form' } } });
  assert.deepEqual(ask('chrome do fill name Somchai and submit'), { kind: 'tool', name: 'mittrcraft_chrome', arguments: { action: 'chrome.do', parameters: { goal: 'fill name Somchai and submit' } } });
  assert.deepEqual(ask('computer list apps'), { kind: 'tool', name: 'mittrcraft_computer', arguments: { action: 'computer.list_apps', parameters: {} } });
  assert.deepEqual(ask('computer screenshot'), { kind: 'tool', name: 'mittrcraft_computer', arguments: { action: 'computer.screenshot', parameters: {} } });
  assert.deepEqual(ask('read jira MRKB-1'), { kind: 'tool', name: 'mittrcraft_work', arguments: { action: 'jira.get_issue', parameters: { key: 'MRKB-1' } } });
  assert.deepEqual(ask('read plane https://stub-plane.invalid/techflow/projects/tf/issues/7'), { kind: 'tool', name: 'mittrcraft_work', arguments: { action: 'plane.get_issue', parameters: { ref: 'https://stub-plane.invalid/techflow/projects/tf/issues/7' } } });
  assert.deepEqual(ask('capture the page'), { kind: 'tool', name: 'openchamber_web', arguments: { action: 'browser.capture', parameters: {} } });
  assert.deepEqual(ask('call openchamber session.create {"prompt":"hi"}'), { kind: 'tool', name: 'openchamber', arguments: { action: 'session.create', parameters: { prompt: 'hi' } } });
  assert.deepEqual(decideReply({ messages: [{ role: 'user', content: 'raw shell {"command":"true","description":"d"}' }], tools: toolsNamed('shell') }, { alias: 'a' }), { kind: 'tool', name: 'shell', arguments: { command: 'true', description: 'd' } });
  assert.deepEqual(ask('list your tools'), { kind: 'text', text: 'Tools offered: mittrcraft_chrome, mittrcraft_computer, mittrcraft_work, openchamber, openchamber_web' });
  assert.deepEqual(decideReply({ messages: [{ role: 'user', content: 'chrome open http://x.test/' }], tools: toolsNamed('openchamber') }, { alias: 'a' }), { kind: 'text', text: 'Stub answer from a: mittrcraft_chrome is not offered.' });
});

test('a tool result answers only the turn it belongs to', () => {
  const tools = toolsNamed('mittrcraft_computer');
  const messages = [
    { role: 'user', content: 'computer list apps' },
    { role: 'tool', content: 'Finder' },
    { role: 'assistant', content: 'Stub answer from a: Finder' },
    { role: 'user', content: 'computer screenshot' },
  ];
  assert.equal(decideReply({ messages, tools }, { alias: 'a' }).kind, 'tool');
  assert.deepEqual(decideReply({ messages: [...messages, { role: 'tool', content: 'saved' }], tools }, { alias: 'a' }), { kind: 'text', text: 'Stub answer from a: saved' });
});

test('each completion records the tools offered and the sha256 of every image it carries, never a header', async () => {
  const { platform, base } = await start();
  try {
    const sa = await signIn(base, 'SA');
    const image = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
    await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sa.accessToken}`, 'content-type': 'application/json', 'x-secret-header': 'never-recorded' },
      body: JSON.stringify({
        model: 'stub-sa-fast',
        stream: true,
        tools: toolsNamed('mittrcraft_chrome'),
        messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: image } }] }],
      }),
    }).then((r) => r.text());
    const [record] = platform.snapshot().records;
    assert.deepEqual(record.tools, ['mittrcraft_chrome']);
    assert.deepEqual(record.images, [{ mime: 'image/png', bytes: PNG_BYTES.length, sha256: crypto.createHash('sha256').update(PNG_BYTES).digest('hex') }]);
    assert.equal(JSON.stringify(platform.snapshot()).includes('never-recorded'), false);
    assert.equal(JSON.stringify(platform.snapshot()).includes(sa.accessToken), false);
  } finally {
    await platform.close();
  }
});

const post = (base, session, route, body) => fetch(`${base}${route}`, {
  method: 'POST',
  headers: { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

const FORM_SNAPSHOT = '- textbox "Name" [ref=e1]\n- textbox "Email" [ref=e2]\n- button "Submit" [ref=e3]';

test('the browser next step fills the name, clicks submit, then is done', async () => {
  const { platform, base } = await start();
  try {
    const sa = await signIn(base, 'SA');
    const goal = 'fill name Somchai and submit';
    const first = await post(base, sa, '/desktop/browser/next-step', { goal, snapshot: FORM_SNAPSHOT, history: [] });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.step, { action: 'fill', ref: 'e1', value: 'Somchai' });
    const second = await post(base, sa, '/desktop/browser/next-step', { goal, snapshot: FORM_SNAPSHOT, history: ['fill e1'] });
    assert.deepEqual(second.body.step, { action: 'click', ref: 'e3' });
    const third = await post(base, sa, '/desktop/browser/next-step', { goal, snapshot: 'Thanks', history: ['fill e1', 'click e3'] });
    assert.equal(third.body.step.action, 'done');
    const asked = await post(base, sa, '/desktop/browser/next-step', { goal: 'fill the email field and submit', snapshot: FORM_SNAPSHOT, history: [] });
    assert.deepEqual(asked.body.step, { action: 'ask', question: 'What email should I use?' });
    const steps = platform.snapshot().records.filter((r) => r.path === '/desktop/browser/next-step');
    assert.equal(steps.length, 4);
    assert.equal(steps[0].account, 'SA');
  } finally {
    await platform.close();
  }
});

test('a next step can be held back on request', async () => {
  const { platform, base } = await start();
  try {
    const sa = await signIn(base, 'SA');
    platform.control({ nextStepDelayMs: 300 });
    const startedAt = Date.now();
    await post(base, sa, '/desktop/browser/next-step', { goal: 'fill name A and submit', snapshot: FORM_SNAPSHOT, history: [] });
    assert.ok(Date.now() - startedAt >= 280);
  } finally {
    await platform.close();
  }
});

test('Jira and Plane lookups answer per account', async () => {
  const { platform, base } = await start();
  try {
    const sa = await signIn(base, 'SA');
    const sb = await signIn(base, 'SB');
    const jira = await get(base, sa, '/desktop/jira/issues/MRKB-1');
    assert.equal(jira.summary, 'Fix login');
    assert.equal(jira.status, 'In Progress');
    const plane = await get(base, sa, `/desktop/plane/issues?ref=${encodeURIComponent('https://stub-plane.invalid/techflow/projects/tf/issues/7')}`);
    assert.equal(plane.identifier, 'TF-7');
    assert.equal(plane.name, 'Draft spec');
    assert.equal(plane.state, 'Todo');
    const sbJira = await get(base, sb, '/desktop/jira/issues/MRKB-1');
    assert.equal(sbJira.summary, 'SB sees its own card');
    const missing = await fetch(`${base}/desktop/jira/issues/NOPE-9`, { headers: { authorization: `Bearer ${sa.accessToken}` } });
    assert.equal(missing.status, 404);
    const lookups = platform.snapshot().records.filter((r) => r.path.startsWith('/desktop/jira') || r.path.startsWith('/desktop/plane'));
    assert.deepEqual(lookups.map((r) => r.account), ['SA', 'SA', 'SB', 'SA']);
  } finally {
    await platform.close();
  }
});
