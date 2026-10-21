#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const BODY_LIMIT = 4 * 1024 * 1024;
const ACCESS_TTL_MS = 3_600_000;

export const STUB_CONNECTOR_SERVER = 'mittr-stub-law';
export const STUB_CONNECTOR_TOOL = 'lookup';

const skillFile = (name, description, body) => ({
  path: 'SKILL.md',
  content: `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
});

const plainSkill = (name, description, body) => ({ name, version: '1.0.0', description, files: [skillFile(name, description, body)] });

const workItem = (fields) => ({
  phase: null,
  priority: null,
  due: null,
  estimate: null,
  updatedAt: '2026-10-20T08:00:00.000Z',
  ...fields,
});

export const defaultAccounts = ({ connectorCommand }) => ({
  SA: {
    userId: 'stub-user-sa',
    displayName: 'Stub SA',
    models: [{ alias: 'stub-sa-fast', label: 'Stub SA Fast' }, { alias: 'stub-sa-deep', label: 'Stub SA Deep' }],
    skills: [plainSkill('card-analysis', 'Turns a work card into a brief. Use when asked to analyse a card.', 'Read the card and write a brief: goal, scope, risks.')],
    mcp: [{
      name: 'stub-law',
      description: 'Stub law lookup for gate runs.',
      config: { type: 'local', command: connectorCommand },
    }],
    work: [
      workItem({ id: 'jira-10001', title: 'Stub Jira card one', project: 'MRKB', state: 'In Progress', url: 'https://stub-jira.invalid/browse/MRKB-1', source: 'jira', key: 'MRKB-1' }),
      workItem({ id: 'plane-tf-7', title: 'Stub Plane item in techflow', project: 'TF', state: 'Todo', url: 'https://stub-plane.invalid/techflow/projects/tf/issues/7', source: 'plane', key: 'TF-7', workspace: 'techflow' }),
      workItem({ id: 'plane-mit-3', title: 'Stub Plane item in mittr', project: 'MIT', state: 'Done', url: 'https://stub-plane.invalid/mittr/projects/mit/issues/3', source: 'plane', key: 'MIT-3', workspace: 'mittr' }),
    ],
    jiraName: 'Stub Jira SA',
  },
  SB: {
    userId: 'stub-user-sb',
    displayName: 'Stub SB',
    models: [{ alias: 'stub-sb-fast', label: 'Stub SB Fast' }],
    skills: [plainSkill('notes', 'Keeps short meeting notes. Use when asked for notes.', 'Write the notes as a short list.')],
    mcp: [],
    work: [
      workItem({ id: 'plane-ops-2', title: 'Stub Plane item for SB', project: 'OPS', state: 'Todo', url: 'https://stub-plane.invalid/ops/projects/ops/issues/2', source: 'plane', key: 'OPS-2', workspace: 'ops' }),
    ],
    jiraName: 'Stub Jira SB',
  },
});

const challengeOf = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');
const token = (prefix) => `${prefix}_${crypto.randomBytes(16).toString('hex')}`;

const sse = (res, frames) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  for (const frame of frames) res.write(`data: ${frame}\n\n`);
  res.end();
};

const chunk = (model, delta, finishReason = null, usage = null) => {
  const frame = {
    id: 'chatcmpl-stub',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage) frame.usage = usage;
  return JSON.stringify(frame);
};

const USAGE = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 };

const textsOf = (value, found = []) => {
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) value.forEach((item) => textsOf(item, found));
  else if (value && typeof value === 'object') {
    if (typeof value.text === 'string') found.push(value.text);
    else if (value.content !== undefined) textsOf(value.content, found);
  }
  return found;
};

const messagesOf = (body) => (Array.isArray(body?.messages) ? body.messages : []);
const roleText = (body, role) => messagesOf(body).filter((m) => m?.role === role).map((m) => textsOf(m.content).join('\n')).join('\n');
const lastUserText = (body) => {
  const users = messagesOf(body).filter((m) => m?.role === 'user');
  return users.length ? textsOf(users[users.length - 1].content).join('\n') : '';
};
const toolResults = (body) => messagesOf(body).filter((m) => m?.role === 'tool').map((m) => textsOf(m.content).join('\n'));
const turnToolResults = (body) => {
  const messages = messagesOf(body);
  const lastUser = messages.map((m) => m?.role).lastIndexOf('user');
  return messages.slice(lastUser + 1).filter((m) => m?.role === 'tool').map((m) => textsOf(m.content).join('\n'));
};

const DATA_URI = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s;

export const imagesOf = (body) => {
  const found = [];
  const walk = (value) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || Object(value) !== value) return;
    if (value.type === 'image_url' || value.type === 'input_image') {
      const url = value.image_url === String(value.image_url) ? value.image_url : String(value.image_url?.url ?? '');
      const match = DATA_URI.exec(url);
      if (match) {
        const bytes = Buffer.from(match[2], 'base64');
        found.push({ mime: match[1], bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
      }
      return;
    }
    Object.values(value).forEach(walk);
  };
  walk(messagesOf(body));
  return found;
};
const offeredTools = (body) => (Array.isArray(body?.tools) ? body.tools : []).map((t) => t?.function ?? t).filter((t) => t?.name);

export const availableSkills = (system) => {
  const block = /<available_skills>([\s\S]*?)<\/available_skills>/.exec(system)?.[1] ?? '';
  return [...block.matchAll(/<name>\s*([^<\s]+)\s*<\/name>/g)].map((match) => match[1]);
};

const firstStringParam = (tool) => {
  const schema = tool?.parameters ?? {};
  const props = schema.properties ?? {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  return required.find((name) => props[name]?.type === 'string') ?? Object.keys(props).find((name) => props[name]?.type === 'string') ?? 'name';
};

const TOOL_PHRASES = [
  [/^chrome open (\S+)\s*$/i, (m) => ['mittrcraft_chrome', 'chrome.open', { url: m[1] }]],
  [/^chrome do (.+)$/is, (m) => ['mittrcraft_chrome', 'chrome.do', { goal: m[1].trim() }]],
  [/^computer list apps\s*$/i, () => ['mittrcraft_computer', 'computer.list_apps', {}]],
  [/^computer screenshot\s*$/i, () => ['mittrcraft_computer', 'computer.screenshot', {}]],
  [/^read jira (\S+)\s*$/i, (m) => ['mittrcraft_work', 'jira.get_issue', { key: m[1] }]],
  [/^read plane (\S+)\s*$/i, (m) => ['mittrcraft_work', 'plane.get_issue', { ref: m[1] }]],
  [/^capture the page\s*$/i, () => ['openchamber_web', 'browser.capture', {}]],
  [/^raw (\S+) (\{.*\})\s*$/is, (m) => [m[1], null, JSON.parse(m[2])]],
  [/^call (\S+) (\S+)(?: (\{.*\}))?\s*$/is, (m) => [m[1], m[2], m[3] ? JSON.parse(m[3]) : {}]],
];

export const phraseCall = (text) => {
  const trimmed = String(text ?? '').trim();
  for (const [pattern, build] of TOOL_PHRASES) {
    const match = pattern.exec(trimmed);
    if (match) {
      const [name, action, parameters] = build(match);
      return action === null ? { name, arguments: parameters } : { name, arguments: { action, parameters } };
    }
  }
  return null;
};

export const decideReply = (body, { alias }) => {
  const system = roleText(body, 'system');
  const user = lastUserText(body);
  const results = turnToolResults(body);
  const tools = offeredTools(body);
  if (results.length) return { kind: 'text', text: `Stub answer from ${alias}: ${results[results.length - 1].slice(0, 400)}` };
  if (/^list your tools\s*$/i.test(user.trim())) return { kind: 'text', text: `Tools offered: ${tools.map((t) => t.name).sort().join(', ')}` };
  const phrased = phraseCall(user);
  if (phrased) {
    if (!tools.some((t) => t.name === phrased.name)) return { kind: 'text', text: `Stub answer from ${alias}: ${phrased.name} is not offered.` };
    return { kind: 'tool', ...phrased };
  }
  const callPath = `tools[${JSON.stringify(STUB_CONNECTOR_SERVER)}].${STUB_CONNECTOR_TOOL}`;
  if (/\blookup\b/i.test(user) && tools.some((t) => t.name === 'execute') && system.includes(`${callPath}(`)) {
    return { kind: 'tool', name: 'execute', arguments: { code: `return await ${callPath}({ query: "41" })` } };
  }
  const skillWanted = /use the skill ([a-z0-9-]+)/i.exec(user)?.[1];
  const skillTool = tools.find((t) => t.name === 'skill');
  if (skillWanted && skillTool) return { kind: 'tool', name: 'skill', arguments: { [firstStringParam(skillTool)]: skillWanted } };
  return { kind: 'text', text: `Stub answer from ${alias}.` };
};

const ASK_EMAIL = 'What email should I use?';
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;

const refFor = (snapshot, kind, label, fallback) => {
  const line = String(snapshot ?? '').split('\n').find((text) => new RegExp(`${kind}[^\\n]*"${label}"`, 'i').test(text));
  return /\[ref=(e\d+)\]/.exec(line ?? '')?.[1] ?? fallback;
};

export const nextBrowserStep = ({ goal, snapshot, history }) => {
  const text = String(goal ?? '');
  const done = Array.isArray(history) ? history.length : 0;
  if (/\bemail\b/i.test(text) && !EMAIL.test(text)) return { action: 'ask', question: ASK_EMAIL };
  const name = /\bname\s+(\S+)/i.exec(text)?.[1] ?? 'Somchai';
  if (done === 0) return { action: 'fill', ref: refFor(snapshot, 'textbox', 'Name', 'e1'), value: name };
  if (done === 1) return { action: 'click', ref: refFor(snapshot, 'button', 'Submit', 'e3') };
  return { action: 'done' };
};

const ISSUES = {
  SA: {
    jira: { 'MRKB-1': { key: 'MRKB-1', summary: 'Fix login', description: 'The login form rejects a valid password.', status: 'In Progress', priority: 'High', assignee: 'Stub SA' } },
    plane: { 'TF-7': { identifier: 'TF-7', name: 'Draft spec', description: 'Write the first draft.', state: 'Todo', priority: 'medium', dueDate: null } },
  },
  SB: {
    jira: { 'MRKB-1': { key: 'MRKB-1', summary: 'SB sees its own card', description: '', status: 'To Do', priority: 'Low', assignee: 'Stub SB' } },
    plane: {},
  },
};

const planeKeyOf = (ref) => {
  const text = String(ref ?? '');
  if (/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(text)) return text.toUpperCase();
  const match = /\/projects\/([a-z0-9]+)\/issues\/(\d+)/i.exec(text);
  return match ? `${match[1].toUpperCase()}-${match[2]}` : null;
};

const readBody = (req) => new Promise((resolve) => {
  let size = 0;
  const parts = [];
  req.on('data', (part) => {
    size += part.length;
    if (size <= BODY_LIMIT) parts.push(part);
  });
  req.on('end', () => {
    const raw = Buffer.concat(parts).toString('utf8');
    try {
      resolve(raw ? JSON.parse(raw) : null);
    } catch {
      resolve(null);
    }
  });
});

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

const quotaOf = (account, out) => {
  const now = Date.now();
  const weekStart = new Date(now - 2 * 86_400_000).toISOString();
  const resetsAt = new Date(now + 5 * 86_400_000).toISOString();
  const agentStatus = {};
  const lines = [];
  for (const model of account.models) {
    const used = out ? 100 : 10;
    lines.push({ modelKey: model.alias, kind: 'chat', label: model.label, used, limit: 100, source: 'user' });
    agentStatus[model.alias] = { modelKey: model.alias, left: 100 - used, limit: 100, resetsAt, state: out ? 'out' : 'ok', percentLeft: 100 - used };
  }
  return { weekStart, resetsAt, lines, agentStatus };
};

const integrationsView = (stored, shape) => {
  const jira = stored.jira ?? {};
  const plane = stored.plane ?? {};
  const slugs = Array.isArray(plane.workspaceSlugs) ? plane.workspaceSlugs : (plane.workspaceSlug ? [plane.workspaceSlug] : []);
  const planeView = {
    id: 'stub-plane-row',
    baseUrl: plane.baseUrl ?? '',
    workspaceSlug: slugs[0] ?? '',
    hasApiKey: Boolean(plane.apiKey),
    configured: Boolean(plane.baseUrl && plane.apiKey && slugs.length),
    webhookSecret: 'stub-webhook-secret-not-for-clients',
  };
  if (shape === 'develop') planeView.workspaceSlugs = slugs;
  return {
    jira: {
      id: 'stub-jira-row',
      baseUrl: jira.baseUrl ?? '',
      email: jira.email ?? '',
      hasToken: Boolean(jira.token),
      configured: Boolean(jira.baseUrl && jira.email && jira.token),
      tokenPreview: 'stub-preview-not-for-clients',
    },
    plane: planeView,
    ownerId: 'stub-owner-not-for-clients',
  };
};

export function createStubPlatform({ accounts, shape = 'develop', log = () => {} } = {}) {
  const state = {
    shape,
    nextAccount: 'SA',
    quotaOut: new Set(),
    withdrawnSkills: new Set(),
    completionsDown: false,
    catalogDelayMs: {},
    accessTtlMs: ACCESS_TTL_MS,
    refreshRefused: false,
    nextStepDelayMs: 0,
    counts: {},
    records: [],
    codes: new Map(),
    access: new Map(),
    refresh: new Map(),
    integrations: new Map(),
    puts: [],
  };

  const count = (key) => { state.counts[key] = (state.counts[key] ?? 0) + 1; };

  const accountByBearer = (req) => {
    const header = String(req.headers.authorization ?? '');
    const value = header.startsWith('Bearer ') ? header.slice(7) : '';
    const entry = state.access.get(value);
    return entry && entry.expiresAt > Date.now() ? entry.account : null;
  };

  const sessionFor = (accountName) => {
    const account = accounts[accountName];
    const accessToken = token('stub_at');
    const refreshToken = token('stub_rt');
    const expiresAt = Date.now() + state.accessTtlMs;
    state.access.set(accessToken, { account: accountName, expiresAt });
    state.refresh.set(refreshToken, accountName);
    return { accessToken, refreshToken, expiresAt, subject: { userId: account.userId, displayName: account.displayName } };
  };

  const catalogOf = (accountName) => {
    const account = accounts[accountName];
    return {
      bundleVersion: 1 + state.withdrawnSkills.size,
      subject: { userId: account.userId, displayName: account.displayName },
      models: account.models,
      skills: account.skills.filter((skill) => !state.withdrawnSkills.has(`${accountName}:${skill.name}`)),
      mcp: account.mcp,
      knowledge: [],
    };
  };

  const control = (body) => {
    if (body?.shape === 'develop' || body?.shape === 'main') state.shape = body.shape;
    if (body?.nextAccount && accounts[body.nextAccount]) state.nextAccount = body.nextAccount;
    if (body?.quotaOut && typeof body.quotaOut === 'object') {
      for (const [name, out] of Object.entries(body.quotaOut)) {
        if (out) state.quotaOut.add(name);
        else state.quotaOut.delete(name);
      }
    }
    if (body?.withdrawSkill) state.withdrawnSkills.add(String(body.withdrawSkill));
    if (body?.restoreSkill) state.withdrawnSkills.delete(String(body.restoreSkill));
    if (typeof body?.completionsDown === 'boolean') state.completionsDown = body.completionsDown;
    if (body?.catalogDelayMs && typeof body.catalogDelayMs === 'object') state.catalogDelayMs = { ...body.catalogDelayMs };
    if (Number.isFinite(body?.accessTtlMs)) state.accessTtlMs = body.accessTtlMs;
    if (typeof body?.refreshRefused === 'boolean') state.refreshRefused = body.refreshRefused;
    if (Number.isFinite(body?.nextStepDelayMs)) state.nextStepDelayMs = body.nextStepDelayMs;
    if (body?.resetCounts) {
      state.counts = {};
      state.records = [];
      state.puts = [];
    }
    return snapshot();
  };

  const snapshot = () => ({
    shape: state.shape,
    nextAccount: state.nextAccount,
    quotaOut: [...state.quotaOut],
    withdrawnSkills: [...state.withdrawnSkills],
    catalogDelayMs: { ...state.catalogDelayMs },
    accessTtlMs: state.accessTtlMs,
    refreshRefused: state.refreshRefused,
    nextStepDelayMs: state.nextStepDelayMs,
    counts: { ...state.counts },
    puts: state.puts.slice(),
    records: state.records.slice(-200),
  });

  const completions = (req, res, body, accountName) => {
    const account = accounts[accountName];
    const alias = String(body?.model ?? account.models[0]?.alias ?? 'stub');
    const decision = decideReply(body, { alias });
    const system = roleText(body, 'system');
    state.records.push({
      at: Date.now(),
      path: '/v1/chat/completions',
      account: accountName,
      model: alias,
      session: req.headers['x-opencode-session-id'] ?? null,
      tools: offeredTools(body).map((t) => t.name),
      skills: availableSkills(system),
      images: imagesOf(body),
      user: lastUserText(body).slice(0, 300),
      toolResults: toolResults(body).map((text) => text.slice(0, 300)),
      decision: decision.kind === 'tool' ? { tool: decision.name, arguments: decision.arguments } : { text: decision.text },
    });
    if (decision.kind === 'tool') {
      return sse(res, [
        chunk(alias, { role: 'assistant', tool_calls: [{ index: 0, id: `call_${state.records.length}`, type: 'function', function: { name: decision.name, arguments: JSON.stringify(decision.arguments) } }] }),
        chunk(alias, {}, 'tool_calls', USAGE),
        '[DONE]',
      ]);
    }
    if (body?.stream) {
      return sse(res, [chunk(alias, { role: 'assistant', content: decision.text }), chunk(alias, {}, 'stop', USAGE), '[DONE]']);
    }
    return json(res, 200, {
      id: 'chatcmpl-stub', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: alias,
      choices: [{ index: 0, message: { role: 'assistant', content: decision.text }, finish_reason: 'stop' }],
      usage: USAGE,
    });
  };

  const handle = async (req, res) => {
    if (!LOOPBACK.has(req.socket.remoteAddress)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = `${req.method} ${url.pathname}`;
    if (!url.pathname.startsWith('/__stub/')) count(route);
    log(`${new Date().toISOString()} ${route}`);
    const body = req.method === 'GET' ? null : await readBody(req);

    if (route === 'GET /__stub/state') return json(res, 200, snapshot());
    if (route === 'POST /__stub/control') return json(res, 200, control(body));

    if (route === 'GET /auth/desktop/start') {
      const challenge = url.searchParams.get('code_challenge') ?? '';
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const accountName = accounts[url.searchParams.get('account')] ? url.searchParams.get('account') : state.nextAccount;
      if (!challenge || !redirectUri) return json(res, 400, { error: 'code_challenge and redirect_uri are required' });
      const code = token('stub_code');
      state.codes.set(code, { challenge, redirectUri, account: accountName });
      const target = new URL(redirectUri);
      target.searchParams.set('code', code);
      res.writeHead(302, { location: target.toString() });
      res.end();
      return;
    }
    if (route === 'POST /auth/desktop/exchange') {
      const pending = state.codes.get(body?.code);
      state.codes.delete(body?.code);
      if (!pending || pending.redirectUri !== body?.redirect_uri || challengeOf(String(body?.code_verifier ?? '')) !== pending.challenge) {
        return json(res, 400, { error: 'invalid_grant' });
      }
      return json(res, 200, sessionFor(pending.account));
    }
    if (route === 'POST /auth/desktop/refresh') {
      const accountName = state.refresh.get(body?.refresh_token);
      if (!accountName || state.refreshRefused) return json(res, 401, { error: 'invalid_refresh_token' });
      state.refresh.delete(body.refresh_token);
      return json(res, 200, sessionFor(accountName));
    }

    const accountName = accountByBearer(req);
    if (!accountName) return json(res, 401, { error: 'Unauthorized' });
    const account = accounts[accountName];

    if (route === 'GET /desktop/catalog') {
      const delay = Number(state.catalogDelayMs[accountName] ?? 0);
      if (delay > 0) await new Promise((resolve) => { setTimeout(resolve, delay); });
      return json(res, 200, catalogOf(accountName));
    }
    if (route === 'GET /desktop/work') return json(res, 200, { items: account.work, hints: [] });
    if (route === 'POST /desktop/browser/next-step') {
      if (state.nextStepDelayMs > 0) await new Promise((resolve) => { setTimeout(resolve, state.nextStepDelayMs); });
      const step = nextBrowserStep(body ?? {});
      state.records.push({ at: Date.now(), path: '/desktop/browser/next-step', account: accountName, goal: String(body?.goal ?? '').slice(0, 300), historyLength: Array.isArray(body?.history) ? body.history.length : 0, snapshot: String(body?.snapshot ?? '').slice(0, 300), step });
      return json(res, 200, { step, decidedBy: ['stub'], ms: 1 });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/desktop/jira/issues/')) {
      const key = decodeURIComponent(url.pathname.slice('/desktop/jira/issues/'.length));
      state.records.push({ at: Date.now(), path: '/desktop/jira/issues', account: accountName, key });
      const issue = ISSUES[accountName]?.jira[key];
      return issue ? json(res, 200, issue) : json(res, 404, { error: `No Jira issue ${key}` });
    }
    if (route === 'GET /desktop/plane/issues') {
      const ref = url.searchParams.get('ref') ?? '';
      state.records.push({ at: Date.now(), path: '/desktop/plane/issues', account: accountName, ref: ref.slice(0, 300) });
      const issue = ISSUES[accountName]?.plane[planeKeyOf(ref)];
      return issue ? json(res, 200, issue) : json(res, 404, { error: 'No Plane work item for that ref' });
    }
    if (route === 'GET /api/quota/me') return json(res, 200, quotaOf(account, state.quotaOut.has(accountName)));

    if (route === 'GET /api/integrations') return json(res, 200, integrationsView(state.integrations.get(accountName) ?? {}, state.shape));
    if (route === 'PUT /api/integrations') {
      const stored = state.integrations.get(accountName) ?? {};
      const fieldsSent = {};
      if (body?.jira && typeof body.jira === 'object') {
        const jira = { ...(stored.jira ?? {}) };
        for (const field of ['baseUrl', 'email']) if (typeof body.jira[field] === 'string') jira[field] = body.jira[field];
        if (typeof body.jira.token === 'string' && body.jira.token) jira.token = body.jira.token;
        stored.jira = jira;
        fieldsSent.jira = Object.keys(body.jira).sort();
      }
      if (body?.plane && typeof body.plane === 'object') {
        const plane = { ...(stored.plane ?? {}) };
        if (typeof body.plane.baseUrl === 'string') plane.baseUrl = body.plane.baseUrl;
        if (state.shape === 'develop' && Array.isArray(body.plane.workspaceSlugs)) plane.workspaceSlugs = body.plane.workspaceSlugs.map(String);
        else if (typeof body.plane.workspaceSlug === 'string') {
          plane.workspaceSlug = body.plane.workspaceSlug;
          delete plane.workspaceSlugs;
        }
        if (typeof body.plane.apiKey === 'string' && body.plane.apiKey) plane.apiKey = body.plane.apiKey;
        stored.plane = plane;
        fieldsSent.plane = Object.keys(body.plane).sort();
      }
      state.integrations.set(accountName, stored);
      state.puts.push({ at: Date.now(), account: accountName, fields: fieldsSent });
      return json(res, 200, integrationsView(stored, state.shape));
    }
    if (route === 'POST /api/integrations/jira/test') {
      const jira = state.integrations.get(accountName)?.jira;
      if (!jira?.token) return json(res, 200, { ok: false, error: 'Jira is not configured' });
      return json(res, 200, { ok: true, displayName: account.jiraName, email: jira.email, accountId: 'stub-not-for-clients' });
    }
    if (route === 'POST /api/integrations/plane/test') {
      const plane = state.integrations.get(accountName)?.plane;
      if (!plane?.apiKey) return json(res, 200, { ok: false, error: 'Plane is not configured' });
      if (state.shape === 'main') return json(res, 200, { ok: true, count: 2, workspaceId: 'stub-not-for-clients' });
      const slugs = plane.workspaceSlugs ?? (plane.workspaceSlug ? [plane.workspaceSlug] : []);
      const workspaces = slugs.map((slug, index) => ({ slug, ok: true, count: index + 2, id: `stub-ws-${index}`, projects: ['stub-not-for-clients'] }));
      return json(res, 200, { ok: true, count: workspaces.reduce((total, w) => total + w.count, 0), workspaces, workspaceId: 'stub-not-for-clients' });
    }

    if (route === 'POST /v1/chat/completions') {
      if (state.completionsDown) return json(res, 503, { error: { message: 'stub completions are down' } });
      return completions(req, res, body, accountName);
    }
    return json(res, 404, { error: 'Not found' });
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'stub failure' });
      else res.end();
    });
  });

  return {
    server,
    state,
    snapshot,
    control,
    listen: (port = 0) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve(server.address().port));
    }),
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

const argValue = (argv, flag, fallback = null) => {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : argv[index + 1] ?? fallback;
};

const main = async () => {
  const argv = process.argv.slice(2);
  const port = Number(argValue(argv, '--port', '0'));
  const shape = argValue(argv, '--shape', 'develop');
  const logFile = argValue(argv, '--log');
  const mcpLog = argValue(argv, '--mcp-log', path.join(process.cwd(), 'stub-mcp.jsonl'));
  const nodeBin = argValue(argv, '--node', process.execPath);
  const connectorCommand = [nodeBin, path.join(HERE, 'stub-mcp-server.mjs'), '--log', mcpLog, '--marker', 'gate-stub-law'];
  const platform = createStubPlatform({
    accounts: defaultAccounts({ connectorCommand }),
    shape,
    log: (line) => { if (logFile) fs.appendFileSync(logFile, `${line}\n`); },
  });
  const bound = await platform.listen(port);
  process.stdout.write(`stub platform listening on 127.0.0.1:${bound}\n`);
  const stop = () => platform.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
