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

const wavOf = (seconds, rate = 16000, fill = 0) => {
  const samples = Math.round(seconds * rate);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) buffer.writeInt16LE(fill, 44 + i * 2);
  return buffer;
};

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const transcribe = (base, session, wav) => {
  const form = new FormData();
  form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  return fetch(`${base}/desktop/speech/transcribe`, { method: 'POST', headers: { authorization: `Bearer ${session.accessToken}` }, body: form })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
};

test('speech readiness answers ready, not configured and voice off', async () => {
  const { platform, base } = await start();
  try {
    const sa = await signIn(base, 'SA');
    const ready = await get(base, sa, '/desktop/speech/readiness');
    assert.deepEqual([ready.listen.ready, ready.speak.ready, ready.voice.ready], [true, true, true]);
    for (const name of ['silenceMs', 'startWaitMs', 'voiceSilenceMs']) assert.ok(Number.isInteger(ready[name]));
    platform.control({ speech: { readiness: 'not_configured' } });
    const off = await get(base, sa, '/desktop/speech/readiness');
    assert.deepEqual([off.listen.ready, off.speak.ready, off.voice.ready], [false, false, false]);
    platform.control({ speech: { readiness: 'voice_off' } });
    const voiceOff = await get(base, sa, '/desktop/speech/readiness');
    assert.deepEqual([voiceOff.listen.ready, voiceOff.speak.ready, voiceOff.voice.ready], [true, true, false]);
    assert.equal((await fetch(`${base}/desktop/speech/readiness`)).status, 401);
  } finally {
    await platform.close();
  }
});

test('transcribe maps a fixture sha256 to its transcript and records only facts about the audio', async () => {
  const { platform, base } = await start();
  try {
    const sa = await signIn(base, 'SA');
    const fixture = wavOf(0.5, 16000, 1200);
    platform.control({ speech: { transcripts: { [sha(fixture)]: { name: 'sessions-en', transcript: 'what sessions are running' } } } });
    const heard = await transcribe(base, sa, fixture);
    assert.equal(heard.status, 201);
    assert.equal(heard.body.text, 'what sessions are running');
    assert.ok(Number.isFinite(heard.body.ms));
    platform.control({ speech: { nextTranscripts: ['yes'] } });
    assert.equal((await transcribe(base, sa, wavOf(0.3))).body.text, 'yes');
    const unmatched = await transcribe(base, sa, wavOf(0.2));
    assert.equal(unmatched.status, 422);
    assert.deepEqual(unmatched.body, { code: 'empty_transcript' });
    const records = platform.snapshot().records.filter((r) => r.path === '/desktop/speech/transcribe');
    assert.deepEqual(records.map((r) => r.matched), ['fixture:sessions-en', 'queued', 'none']);
    assert.equal(records[0].sha256, sha(fixture));
    assert.deepEqual(records[0].wav, { rate: 16000, channels: 1, bits: 16, seconds: 0.5 });
    assert.equal(records[0].account, 'SA');
    const recorded = JSON.stringify(platform.snapshot().records);
    assert.equal(recorded.includes('what sessions are running'), false);
    assert.equal(recorded.includes(sa.accessToken), false);
  } finally {
    await platform.close();
  }
});

test('transcribe answers the quota, empty and slow modes', async () => {
  const { platform, base } = await start();
  try {
    const sa = await signIn(base, 'SA');
    const fixture = wavOf(0.2, 16000, 900);
    platform.control({ speech: { transcripts: { [sha(fixture)]: 'hello' }, stt: 'quota' } });
    const quota = await transcribe(base, sa, fixture);
    assert.equal(quota.status, 429);
    assert.equal(quota.body.code, 'llm_quota_exhausted');
    assert.equal(quota.body.kind, 'stt');
    const days = (Date.parse(quota.body.resetsAt) - Date.now()) / 86_400_000;
    assert.ok(days > 6.9 && days <= 7);
    platform.control({ speech: { stt: 'empty' } });
    assert.deepEqual(await transcribe(base, sa, fixture), { status: 422, body: { code: 'empty_transcript' } });
    platform.control({ speech: { stt: 'slow', slowMs: 300 } });
    const startedAt = Date.now();
    const slow = await transcribe(base, sa, fixture);
    assert.ok(Date.now() - startedAt >= 280);
    assert.equal(slow.body.text, 'hello');
    platform.control({ speech: { stt: null } });
    assert.equal((await transcribe(base, sa, fixture)).status, 201);
  } finally {
    await platform.close();
  }
});

test('synthesize streams silence in four parts with the platform content type, and answers quota and not configured', async () => {
  const { platform, base } = await start();
  try {
    const sa = await signIn(base, 'SA');
    platform.control({ speech: { partGapMs: 20 } });
    const text = 'x'.repeat(200);
    const response = await fetch(`${base}/desktop/speech/synthesize`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sa.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/pcm;rate=24000;channels=1');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const parts = [];
    for await (const part of response.body) parts.push(part);
    const audio = Buffer.concat(parts);
    assert.equal(audio.length, 24000 * 2);
    assert.ok(audio.every((byte) => byte === 0));
    const say = (body) => fetch(`${base}/desktop/speech/synthesize`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sa.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.deepEqual(await say({ text: '   ' }), { status: 400, body: { code: 'bad_request' } });
    assert.deepEqual(await say({ text: 'y'.repeat(4001) }), { status: 400, body: { code: 'bad_request' } });
    platform.control({ speech: { tts: 'quota' } });
    const quota = await say({ text: 'hello' });
    assert.equal(quota.status, 429);
    assert.equal(quota.body.kind, 'tts');
    platform.control({ speech: { tts: 'not_configured' } });
    assert.deepEqual(await say({ text: 'hello' }), { status: 409, body: { code: 'not_configured' } });
    const records = platform.snapshot().records.filter((r) => r.path === '/desktop/speech/synthesize');
    assert.deepEqual(records[0], { ...records[0], account: 'SA', chars: 200, bytes: 48000, parts: 4 });
    assert.equal(JSON.stringify(records).includes('x'.repeat(50)), false);
  } finally {
    await platform.close();
  }
});

const VOICE_TOOLS = [
  { name: 'mittrcraft', description: 'control', parameters: { type: 'object', properties: { action: { type: 'string' } } } },
  { name: 'mittrcraft_web', description: 'web', parameters: { type: 'object', properties: { action: { type: 'string' } } } },
  { name: 'mittrcraft_voice', description: 'voice', parameters: { type: 'object', properties: { action: { type: 'string' } } } },
  { name: 'mittrcraft_end', description: 'end', parameters: { type: 'object', properties: {} } },
];

const voiceStep = async (base, session, body) => {
  const response = await fetch(`${base}/desktop/voice/step`, {
    method: 'POST',
    headers: { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) return { status: response.status, body: await response.json() };
  const text = await response.text();
  const events = text.split('\n\n').filter((block) => block.startsWith('data: ')).map((block) => JSON.parse(block.slice(6)));
  return { status: response.status, events };
};

const userTurn = (said, history = []) => ({ locale: 'en', context: 'ctx', tools: VOICE_TOOLS, messages: [...history, { role: 'user', content: said }] });
const callsOf = (events) => events.filter((e) => e.type === 'tool-call').map((e) => ({ name: e.name, arguments: JSON.parse(e.arguments) }));
const textOf = (events) => events.filter((e) => e.type === 'text-delta').map((e) => e.text).join('');
const withResult = (body, events, results) => {
  const calls = events.filter((e) => e.type === 'tool-call');
  return {
    ...body,
    messages: [
      ...body.messages,
      { role: 'assistant', content: textOf(events), toolCalls: calls.map(({ id, name, arguments: args }) => ({ id, name, arguments: args })) },
      ...calls.map((call, index) => ({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(results[index]) })),
    ],
  };
};

const SESSIONS = { sessions: [
  { id: 'ses_old', title: 'old', time: { created: 1000, updated: 1000 } },
  { id: 'ses_new', title: 'new', time: { created: 5000, updated: 5000 } },
] };

test('the voice step lists sessions, then names the count', async () => {
  const { platform, base } = await start();
  try {
    const sa = await signIn(base, 'SA');
    const first = userTurn('what sessions are running');
    const one = await voiceStep(base, sa, first);
    assert.deepEqual(callsOf(one.events), [{ name: 'mittrcraft', arguments: { action: 'session.list' } }]);
    assert.equal(one.events.at(-1).type, 'done');
    const two = await voiceStep(base, sa, withResult(first, one.events, [SESSIONS]));
    assert.deepEqual(callsOf(two.events), []);
    assert.match(textOf(two.events), /\b2 sessions\b/);
    const record = platform.snapshot().records.filter((r) => r.path === '/desktop/voice/step')[0];
    assert.deepEqual(record.tools, ['mittrcraft', 'mittrcraft_web', 'mittrcraft_voice', 'mittrcraft_end']);
    assert.deepEqual(record.calls, ['session.list']);
    assert.equal(record.script, 'sessions');
    assert.equal(JSON.stringify(platform.snapshot().records).includes('what sessions are running'), false);
  } finally {
    await platform.close();
  }
});

test('the voice step sends to the newest session, reads its reply, and asks before a stop', async () => {
  const { platform, base } = await start();
  try {
    const sa = await signIn(base, 'SA');
    const send = userTurn("send 'add a README' to the newest session");
    const listed = await voiceStep(base, sa, send);
    assert.deepEqual(callsOf(listed.events), [{ name: 'mittrcraft', arguments: { action: 'session.list' } }]);
    const sent = await voiceStep(base, sa, withResult(send, listed.events, [SESSIONS]));
    assert.deepEqual(callsOf(sent.events), [{ name: 'mittrcraft', arguments: { action: 'session.send', sessionId: 'ses_new', prompt: 'add a README' } }]);
    const read = userTurn('what did it answer');
    const reading = await voiceStep(base, sa, read);
    assert.deepEqual(callsOf(reading.events), [{ name: 'mittrcraft_voice', arguments: { action: 'session.read_reply', sessionId: 'ses_new' } }]);
    const answered = await voiceStep(base, sa, withResult(read, reading.events, [{ sessionId: 'ses_new', text: 'Stub reply text', truncated: false }]));
    assert.match(textOf(answered.events), /Stub reply text/);
    const stop = await voiceStep(base, sa, userTurn('stop the newest session'));
    assert.deepEqual(callsOf(stop.events), []);
    assert.equal(textOf(stop.events), 'Should I stop it?');
    const yes = userTurn('yes', [{ role: 'user', content: 'stop the newest session' }, { role: 'assistant', content: 'Should I stop it?' }]);
    const yesList = await voiceStep(base, sa, yes);
    assert.deepEqual(callsOf(yesList.events), [{ name: 'mittrcraft', arguments: { action: 'session.list' } }]);
    const stopping = await voiceStep(base, sa, withResult(yes, yesList.events, [SESSIONS]));
    assert.deepEqual(callsOf(stopping.events), [{ name: 'mittrcraft_voice', arguments: { action: 'session.stop', sessionId: 'ses_new' } }]);
  } finally {
    await platform.close();
  }
});

test('the voice step asks before using Chrome, then allows, opens and reads the heading', async () => {
  const { platform, base } = await start();
  try {
    const sa = await signIn(base, 'SA');
    const url = 'http://127.0.0.1:9/form';
    const ask = userTurn(`open ${url} in Chrome and tell me the heading`);
    const opening = await voiceStep(base, sa, ask);
    assert.deepEqual(callsOf(opening.events), [{ name: 'mittrcraft_web', arguments: { action: 'chrome.open', url } }]);
    const refused = await voiceStep(base, sa, withResult(ask, opening.events, [{ error: 'ask', reasonCode: 'site_approval_required', host: '127.0.0.1' }]));
    assert.equal(textOf(refused.events), 'May I use Chrome for this conversation?');
    const yes = userTurn('yes', [{ role: 'user', content: ask.messages[0].content }, { role: 'assistant', content: 'May I use Chrome for this conversation?' }]);
    const allow = await voiceStep(base, sa, yes);
    assert.deepEqual(callsOf(allow.events), [{ name: 'mittrcraft_voice', arguments: { action: 'chrome.allow_site', host: '127.0.0.1' } }]);
    const afterAllow = withResult(yes, allow.events, [{ allowed: true }]);
    const reopen = await voiceStep(base, sa, afterAllow);
    assert.deepEqual(callsOf(reopen.events), [{ name: 'mittrcraft_web', arguments: { action: 'chrome.open', url } }]);
    const afterOpen = withResult(afterAllow, reopen.events, [{ ok: true }]);
    const reading = await voiceStep(base, sa, afterOpen);
    assert.deepEqual(callsOf(reading.events), [{ name: 'mittrcraft_web', arguments: { action: 'chrome.read' } }]);
    const told = await voiceStep(base, sa, withResult(afterOpen, reading.events, [{ text: '# Stub form\n\nName' }]));
    assert.equal(textOf(told.events), 'The heading is "Stub form".');
  } finally {
    await platform.close();
  }
});

test('the voice step keeps calling tools on a Thai carry-on, ends on bye, and breaks the rules on request', async () => {
  const { platform, base } = await start();
  try {
    const sa = await signIn(base, 'SA');
    let body = { ...userTurn('ทำต่อเลย'), locale: 'th' };
    for (let step = 0; step < 3; step += 1) {
      const answer = await voiceStep(base, sa, body);
      assert.deepEqual(callsOf(answer.events), [{ name: 'mittrcraft', arguments: { action: 'session.list' } }]);
      body = withResult(body, answer.events, [SESSIONS]);
    }
    const bye = await voiceStep(base, sa, userTurn('bye'));
    assert.equal(textOf(bye.events), 'Goodbye.');
    assert.deepEqual(callsOf(bye.events), [{ name: 'mittrcraft_end', arguments: {} }]);
    const ended = await voiceStep(base, sa, userTurn('end the conversation'));
    assert.deepEqual(callsOf(ended.events), [{ name: 'mittrcraft_end', arguments: {} }]);
    assert.equal(textOf(ended.events), '');
    platform.control({ speech: { voice: 'rules' } });
    const rules = await voiceStep(base, sa, userTurn('anything'));
    assert.deepEqual(callsOf(rules.events).map((c) => c.arguments.action), ['chrome.read', 'session.send']);
  } finally {
    await platform.close();
  }
});

test('the voice step answers the quota as a frame or a 429, and refuses a body outside the limits as SSE bad_request', async () => {
  const { platform, base } = await start();
  try {
    const sa = await signIn(base, 'SA');
    platform.control({ speech: { voice: 'quota' } });
    const frame = await voiceStep(base, sa, userTurn('hello'));
    assert.equal(frame.status, 200);
    const error = frame.events.find((e) => e.type === 'error');
    assert.equal(error.code, 'llm_quota_exhausted');
    assert.ok(Date.parse(error.resetsAt) > Date.now());
    platform.control({ speech: { voice: 'quota429' } });
    const refused = await voiceStep(base, sa, userTurn('hello'));
    assert.equal(refused.status, 429);
    assert.equal(refused.body.code, 'llm_quota_exhausted');
    platform.control({ speech: { voice: null } });
    const bad = async (body) => {
      const answer = await voiceStep(base, sa, body);
      assert.equal(answer.status, 200);
      assert.deepEqual(answer.events, [{ type: 'error', code: 'bad_request' }]);
    };
    await bad({ ...userTurn('hi'), messages: [] });
    await bad({ ...userTurn('hi'), locale: 'fr' });
    await bad({ ...userTurn('hi'), context: 'c'.repeat(8001) });
    await bad({ ...userTurn('hi'), tools: [] });
    await bad({ ...userTurn('hi'), tools: [...VOICE_TOOLS, VOICE_TOOLS[0]] });
    await bad({ ...userTurn('hi'), tools: [{ ...VOICE_TOOLS[0], name: 'shell' }] });
    await bad({ ...userTurn('hi'), tools: [{ ...VOICE_TOOLS[0], description: 'd'.repeat(4001) }] });
    await bad({ ...userTurn('hi'), messages: [{ role: 'user', content: 'u'.repeat(200_001) }] });
    await bad({ ...userTurn('hi'), messages: Array.from({ length: 61 }, () => ({ role: 'user', content: 'u' })) });
    await bad({ ...userTurn('hi'), messages: [{ role: 'user', content: 'u' }, { role: 'tool', toolCallId: 'nope', name: 'mittrcraft', content: '{}' }] });
    const many = Array.from({ length: 21 }, (_, i) => ({ id: `c${i}`, name: 'mittrcraft', arguments: '{}' }));
    await bad({ ...userTurn('hi'), messages: [{ role: 'user', content: 'u' }, { role: 'assistant', content: '', toolCalls: many }] });
    const refusals = platform.snapshot().records.filter((r) => r.path === '/desktop/voice/step' && r.refused === 'bad_request');
    assert.equal(refusals.length, 11);
  } finally {
    await platform.close();
  }
});

test('a voice step can be held back, and a session prompt can hold the model or ask for a long answer', async () => {
  const { platform, base } = await start();
  try {
    const sa = await signIn(base, 'SA');
    platform.control({ speech: { voiceStepDelayMs: 300 } });
    const startedAt = Date.now();
    await voiceStep(base, sa, userTurn('hello'));
    assert.ok(Date.now() - startedAt >= 280);
    const long = decideReply({ messages: [{ role: 'user', content: 'write a long answer' }] }, { alias: 'a' });
    assert.equal(long.kind, 'text');
    assert.ok(long.text.length >= 6000);
    assert.deepEqual(decideReply({ messages: [{ role: 'user', content: 'hold for 2 seconds' }] }, { alias: 'a' }), { kind: 'text', text: 'Held for 2 seconds.', holdMs: 2000 });
  } finally {
    await platform.close();
  }
});
