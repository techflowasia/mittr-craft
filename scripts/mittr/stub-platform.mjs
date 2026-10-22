#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const BODY_LIMIT = 4 * 1024 * 1024;
const RAW_LIMIT = 12 * 1024 * 1024;
const AUDIO_LIMIT = 10 * 1024 * 1024;
const ACCESS_TTL_MS = 3_600_000;
const DAY_MS = 86_400_000;

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

export const LONG_ANSWER = (() => {
  const sentences = [];
  for (let n = 1; sentences.join(' ').length < 6000; n += 1) sentences.push(`Point ${n} of the long stub answer says one more thing about the gate run.`);
  return sentences.join(' ');
})();

export const decideReply = (body, { alias }) => {
  const system = roleText(body, 'system');
  const user = lastUserText(body);
  const results = turnToolResults(body);
  const tools = offeredTools(body);
  if (results.length) return { kind: 'text', text: `Stub answer from ${alias}: ${results[results.length - 1].slice(0, 400)}` };
  if (/^write a long answer\s*$/i.test(user.trim())) return { kind: 'text', text: LONG_ANSWER };
  const hold = /^hold for (\d+) seconds\s*$/i.exec(user.trim());
  if (hold) return { kind: 'text', text: `Held for ${hold[1]} seconds.`, holdMs: Number(hold[1]) * 1000 };
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

const readRaw = (req) => new Promise((resolve) => {
  let size = 0;
  const parts = [];
  req.on('data', (part) => {
    size += part.length;
    if (size <= RAW_LIMIT) parts.push(part);
  });
  req.on('end', () => resolve({ raw: Buffer.concat(parts), size }));
});

const jsonOf = ({ raw, size }) => {
  if (size > BODY_LIMIT || raw.length === 0) return null;
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
};

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};


export const SPEECH_CONTENT_TYPE = 'audio/pcm;rate=24000;channels=1';
const SPEECH_RATE = 24000;
const SYNTH_PARTS = 4;
const READINESS = Object.freeze({
  ready: { listen: true, speak: true, voice: true },
  not_configured: { listen: false, speak: false, voice: false },
  voice_off: { listen: true, speak: true, voice: false },
});
export const VOICE_TOOL_NAMES = Object.freeze(['mittrcraft', 'mittrcraft_web', 'mittrcraft_voice', 'mittrcraft_end']);
const VOICE_LIMITS = Object.freeze({ context: 8000, messagesMin: 1, messagesMax: 60, chars: 200_000, callsPerMessage: 20, toolsMin: 1, toolsMax: 4, description: 4000, parameters: 30_000 });

export const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

export const wavFacts = (bytes) => {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return null;
  let at = 12;
  let format = null;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 24 <= bytes.length) {
      format = { channels: bytes.readUInt16LE(at + 10), rate: bytes.readUInt32LE(at + 12), bits: bytes.readUInt16LE(at + 22) };
    } else if (id === 'data' && format) {
      const dataBytes = Math.min(size, bytes.length - at - 8);
      const seconds = Math.round((dataBytes / (format.rate * format.channels * (format.bits / 8))) * 1000) / 1000;
      return { rate: format.rate, channels: format.channels, bits: format.bits, seconds };
    }
    at += 8 + size + (size % 2);
  }
  return null;
};

const isObject = (value) => Boolean(value) && Object(value) === value && !Array.isArray(value);

export const voiceStepProblem = (body) => {
  if (!isObject(body)) return 'body';
  if (body.locale !== 'th' && body.locale !== 'en') return 'locale';
  if (body.context !== String(body.context) || body.context.length > VOICE_LIMITS.context) return 'context';
  const { messages, tools } = body;
  if (!Array.isArray(messages) || messages.length < VOICE_LIMITS.messagesMin || messages.length > VOICE_LIMITS.messagesMax) return 'messages';
  let chars = 0;
  const callIds = new Set();
  for (const message of messages) {
    if (!isObject(message) || message.content !== String(message.content)) return 'message';
    chars += message.content.length;
    if (message.role === 'assistant') {
      const calls = message.toolCalls ?? [];
      if (!Array.isArray(calls) || calls.length > VOICE_LIMITS.callsPerMessage) return 'tool_calls';
      for (const call of calls) {
        if (!isObject(call) || call.id !== String(call.id) || call.name !== String(call.name) || call.arguments !== String(call.arguments)) return 'tool_call';
        chars += call.arguments.length;
        callIds.add(call.id);
      }
    } else if (message.role === 'tool') {
      if (!callIds.has(message.toolCallId) || message.name !== String(message.name)) return 'tool_message';
    } else if (message.role !== 'user') return 'role';
  }
  if (chars > VOICE_LIMITS.chars) return 'chars';
  if (!Array.isArray(tools) || tools.length < VOICE_LIMITS.toolsMin || tools.length > VOICE_LIMITS.toolsMax) return 'tools';
  const names = new Set();
  for (const tool of tools) {
    if (!isObject(tool) || !VOICE_TOOL_NAMES.includes(tool.name) || names.has(tool.name)) return 'tool_name';
    names.add(tool.name);
    if (tool.description !== String(tool.description) || tool.description.length > VOICE_LIMITS.description) return 'tool_description';
    if (!isObject(tool.parameters) || JSON.stringify(tool.parameters).length > VOICE_LIMITS.parameters) return 'tool_parameters';
  }
  return null;
};

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const sessionsOf = (result) => {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.sessions)) return result.sessions;
  return [];
};

const newestOf = (sessions) => {
  const stamp = (session) => Number(session?.time?.created ?? session?.time?.updated ?? 0);
  return sessions.reduce((best, session) => (!best || stamp(session) > stamp(best) ? session : best), null);
};

const headingOf = (result) => {
  const text = result === String(result) ? result : String(result?.text ?? result?.markdown ?? result?.content ?? JSON.stringify(result ?? ''));
  return /(?:^|\n)#\s+([^\n]+)/.exec(text)?.[1]?.trim() ?? /"title"\s*:\s*"([^"]+)"/.exec(JSON.stringify(result ?? ''))?.[1] ?? null;
};

const CHROME_ASK = 'May I use Chrome for this conversation?';
const STOP_ASK = 'Should I stop it?';
const CHROME_WANT = /^open (\S+) in chrome and tell me the heading[.?!]?$/i;

export const decideVoiceStep = (body, { mode = null, memory = {} } = {}) => {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const lastUser = messages.map((message) => message.role).lastIndexOf('user');
  const said = String(messages[lastUser]?.content ?? '').trim();
  const history = messages.slice(0, lastUser);
  const turn = messages.slice(lastUser + 1);
  const calls = new Map();
  for (const message of turn) for (const call of message.toolCalls ?? []) calls.set(call.id, { name: call.name, args: parseJson(call.arguments) ?? {} });
  const results = turn.filter((message) => message.role === 'tool').map((message) => ({ action: calls.get(message.toolCallId)?.args?.action ?? null, result: parseJson(message.content) }));
  const last = results.at(-1) ?? null;
  const asked = [...history].reverse().find((message) => message.role === 'assistant' && String(message.content).trim())?.content ?? '';
  for (const { action, result } of results) if (action === 'session.list') memory.sessions = sessionsOf(result);
  const newest = () => newestOf(memory.sessions ?? [])?.id ?? null;
  const text = (key, words) => ({ key, text: words, calls: [] });
  const call = (key, name, args, words = '') => ({ key, text: words, calls: [{ name, arguments: args }] });
  const list = (key) => call(key, 'mittrcraft', { action: 'session.list' });
  const codeOf = (result) => result?.reasonCode ?? (result?.error ? 'error' : 'ok');

  if (mode === 'rules') {
    if (!last) return { key: 'rules', text: '', calls: [{ name: 'mittrcraft_web', arguments: { action: 'chrome.read' } }, { name: 'mittrcraft', arguments: { action: 'session.send', sessionId: newest() ?? 'ses_unknown', prompt: 'add a README' } }] };
    return text('rules', `Results: ${results.map(({ result }) => codeOf(result)).join(', ')}.`);
  }

  const chrome = (key, url, allowFirst) => {
    const host = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return url;
      }
    })();
    if (!last) return allowFirst ? call(key, 'mittrcraft_voice', { action: 'chrome.allow_site', host }) : call(key, 'mittrcraft_web', { action: 'chrome.open', url });
    if (last.action === 'chrome.allow_site') return last.result?.error ? text(key, `Chrome was not allowed: ${codeOf(last.result)}.`) : call(key, 'mittrcraft_web', { action: 'chrome.open', url });
    if (last.action === 'chrome.open') {
      if (last.result?.reasonCode === 'site_approval_required') return text(key, CHROME_ASK);
      if (last.result?.error) return text(key, `Chrome did not open the page: ${codeOf(last.result)}.`);
      return call(key, 'mittrcraft_web', { action: 'chrome.read' });
    }
    const heading = headingOf(last.result);
    return text(key, heading ? `The heading is "${heading}".` : `I could not read a heading: ${codeOf(last.result)}.`);
  };

  if (/^ทำต่อ/.test(said)) return list('carry_on_th');
  if (/^bye[.!]?$/i.test(said)) return call('bye', 'mittrcraft_end', {}, 'Goodbye.');
  if (/^end the conversation[.!]?$/i.test(said)) return call('end', 'mittrcraft_end', {});

  if (/^what sessions are running\??$/i.test(said)) {
    if (!last) return list('sessions');
    const n = sessionsOf(last.result).length;
    return text('sessions', `There ${n === 1 ? 'is' : 'are'} ${n} session${n === 1 ? '' : 's'}.`);
  }
  if (/^send ['"‘’“”]?add a readme['"‘’“”]? to the newest session[.!]?$/i.test(said)) {
    if (!last) return list('send');
    if (last.action === 'session.list') {
      const id = newest();
      if (!id) return text('send', 'There is no session to send to.');
      memory.lastSent = id;
      return call('send', 'mittrcraft', { action: 'session.send', sessionId: id, prompt: 'add a README' });
    }
    if (last.result?.queued) return text('send', 'It is busy, so I queued it.');
    return last.result?.error ? text('send', `It did not go: ${codeOf(last.result)}.`) : text('send', 'Sent it.');
  }
  if (/^what did it answer\??$/i.test(said)) {
    if (!last) return memory.lastSent ? call('read', 'mittrcraft_voice', { action: 'session.read_reply', sessionId: memory.lastSent }) : list('read');
    if (last.action === 'session.list') return newest() ? call('read', 'mittrcraft_voice', { action: 'session.read_reply', sessionId: newest() }) : text('read', 'There is no session.');
    if (last.result?.error) return text('read', `I could not read it: ${codeOf(last.result)}.`);
    return text('read', last.result?.text ? `It answered: ${last.result.text}` : 'It has not answered yet.');
  }
  if (/^stop the newest session[.!]?$/i.test(said)) return text('stop', STOP_ASK);
  if (/^yes[.!]?$/i.test(said) && asked.includes(STOP_ASK)) {
    if (!last) return list('stop_yes');
    if (last.action === 'session.list') return newest() ? call('stop_yes', 'mittrcraft_voice', { action: 'session.stop', sessionId: newest() }) : text('stop_yes', 'There is no session.');
    return last.result?.error ? text('stop_yes', `It did not stop: ${codeOf(last.result)}.`) : text('stop_yes', 'Stopped it.');
  }
  const wanted = CHROME_WANT.exec(said);
  if (wanted) return chrome('chrome', wanted[1], false);
  if (/^yes[.!]?$/i.test(said) && asked.includes(CHROME_ASK)) {
    const earlier = [...history].reverse().map((message) => (message.role === 'user' ? CHROME_WANT.exec(String(message.content).trim()) : null)).find(Boolean);
    if (earlier) return chrome('chrome_yes', earlier[1], true);
  }
  const panel = /^open (\S+) in the browser panel and read it[.!]?$/i.exec(said);
  if (panel) {
    if (!last) return call('panel', 'mittrcraft_web', { action: 'browser.open', url: panel[1] });
    if (last.action === 'browser.open') return last.result?.error ? text('panel', `The panel did not open: ${codeOf(last.result)}.`) : call('panel', 'mittrcraft_web', { action: 'browser.snapshot' });
    const heading = headingOf(last.result);
    return text('panel', heading ? `The panel shows "${heading}".` : `I could not read the panel: ${codeOf(last.result)}.`);
  }
  if (/^which apps are open\??$/i.test(said)) {
    if (!last) return call('apps', 'mittrcraft_web', { action: 'computer.list_apps' });
    const apps = Array.isArray(last.result?.apps) ? last.result.apps : [];
    return last.result?.error ? text('apps', `I could not list the apps: ${codeOf(last.result)}.`) : text('apps', `${apps.length} apps: ${apps.map((app) => app?.name).filter(Boolean).join(', ')}.`);
  }
  return text('other', 'Stub voice heard you.');
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

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
    speech: { readiness: 'ready', stt: null, tts: null, voice: null, slowMs: 8000, partGapMs: 200, voiceStepDelayMs: 0, defaultTranscript: null, nextTranscripts: [], transcripts: new Map() },
    voiceMemory: {},
    voiceCallCount: 0,
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

  const controlSpeech = (patch) => {
    const speech = state.speech;
    for (const name of ['readiness', 'stt', 'tts', 'voice']) if (Object.hasOwn(patch, name)) speech[name] = patch[name] ?? null;
    if (speech.readiness === null || !READINESS[speech.readiness]) speech.readiness = 'ready';
    for (const name of ['slowMs', 'partGapMs', 'voiceStepDelayMs']) if (Number.isFinite(patch[name])) speech[name] = patch[name];
    if (Object.hasOwn(patch, 'defaultTranscript')) speech.defaultTranscript = patch.defaultTranscript === String(patch.defaultTranscript) ? patch.defaultTranscript : null;
    if (Array.isArray(patch.nextTranscripts)) speech.nextTranscripts = patch.nextTranscripts.map(String);
    if (isObject(patch.transcripts)) {
      for (const [digest, entry] of Object.entries(patch.transcripts)) {
        speech.transcripts.set(digest, entry === String(entry) ? { name: digest.slice(0, 12), transcript: entry } : { name: String(entry?.name ?? digest.slice(0, 12)), transcript: String(entry?.transcript ?? '') });
      }
    }
    if (patch.forgetVoice) state.voiceMemory = {};
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
    if (isObject(body?.speech)) controlSpeech(body.speech);
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
    speech: {
      readiness: state.speech.readiness,
      stt: state.speech.stt,
      tts: state.speech.tts,
      voice: state.speech.voice,
      slowMs: state.speech.slowMs,
      partGapMs: state.speech.partGapMs,
      voiceStepDelayMs: state.speech.voiceStepDelayMs,
      fixtures: [...state.speech.transcripts.values()].map((entry) => entry.name),
      queuedTranscripts: state.speech.nextTranscripts.length,
      defaultTranscript: state.speech.defaultTranscript !== null,
    },
    counts: { ...state.counts },
    puts: state.puts.slice(),
    records: state.records.slice(-200),
  });

  const completions = async (req, res, body, accountName) => {
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
    if (decision.holdMs) await sleep(decision.holdMs);
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

  const quotaBody = (kind, label) => {
    const resetsAt = new Date(Date.now() + 7 * DAY_MS).toISOString();
    return { code: 'llm_quota_exhausted', modelKey: `stub-${kind}`, kind, label, resetsAt, message: `Stub ${label} is out of quota` };
  };

  const transcribe = async (req, res, received, accountName) => {
    const record = { at: Date.now(), path: '/desktop/speech/transcribe', account: accountName, mode: state.speech.stt };
    state.records.push(record);
    if (received.size > AUDIO_LIMIT) return json(res, 413, { code: 'audio_too_large' });
    const contentType = String(req.headers['content-type'] ?? '');
    const form = contentType.toLowerCase().startsWith('multipart/form-data')
      ? await new Request('http://127.0.0.1/', { method: 'POST', headers: { 'content-type': contentType }, body: received.raw }).formData().catch(() => null)
      : null;
    const audio = form?.get('audio');
    if (!audio || audio === String(audio) || audio.size === 0) return json(res, 400, { code: 'bad_request' });
    const wav = Buffer.from(await audio.arrayBuffer());
    record.sha256 = sha256Hex(wav);
    record.bytes = wav.length;
    record.wav = wavFacts(wav);
    if (state.speech.stt === 'quota') return json(res, 429, quotaBody('stt', 'speech'));
    if (state.speech.stt === 'not_configured') return json(res, 409, { code: 'not_configured' });
    if (state.speech.stt === 'empty') return json(res, 422, { code: 'empty_transcript' });
    if (state.speech.stt === 'slow') await sleep(state.speech.slowMs);
    const startedAt = Date.now();
    const fixture = state.speech.transcripts.get(record.sha256);
    let transcript = null;
    if (fixture) {
      record.matched = `fixture:${fixture.name}`;
      transcript = fixture.transcript;
    } else if (state.speech.nextTranscripts.length > 0) {
      record.matched = 'queued';
      transcript = state.speech.nextTranscripts.shift();
    } else if (state.speech.defaultTranscript !== null) {
      record.matched = 'default';
      transcript = state.speech.defaultTranscript;
    } else {
      record.matched = 'none';
    }
    if (!transcript) return json(res, 422, { code: 'empty_transcript' });
    return json(res, 201, { text: transcript, ms: Date.now() - startedAt });
  };

  const synthesize = async (res, body, accountName) => {
    const text = body?.text;
    const record = { at: Date.now(), path: '/desktop/speech/synthesize', account: accountName, mode: state.speech.tts, chars: text === String(text) ? text.length : null };
    state.records.push(record);
    if (text !== String(text) || !text.trim() || text.trim().length > 4000) return json(res, 400, { code: 'bad_request' });
    if (state.speech.tts === 'quota') return json(res, 429, quotaBody('tts', 'spoken replies'));
    if (state.speech.tts === 'not_configured') return json(res, 409, { code: 'not_configured' });
    const samples = Math.round((text.length / 20) * 0.1 * SPEECH_RATE);
    const audio = Buffer.alloc(samples * 2);
    record.bytes = audio.length;
    record.parts = SYNTH_PARTS;
    res.writeHead(200, { 'content-type': SPEECH_CONTENT_TYPE, 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' });
    const size = Math.ceil(audio.length / SYNTH_PARTS / 2) * 2;
    for (let part = 0; part < SYNTH_PARTS; part += 1) {
      if (part > 0) await sleep(state.speech.partGapMs);
      if (res.destroyed) return undefined;
      res.write(audio.subarray(part * size, Math.min(audio.length, (part + 1) * size)));
    }
    res.end();
    return undefined;
  };

  const voiceStep = async (res, body, accountName) => {
    const record = { at: Date.now(), path: '/desktop/voice/step', account: accountName, mode: state.speech.voice };
    state.records.push(record);
    if (state.speech.voiceStepDelayMs > 0) await sleep(state.speech.voiceStepDelayMs);
    if (state.speech.voice === 'quota429') {
      record.refused = 'quota429';
      return json(res, 429, quotaBody('chat', 'voice'));
    }
    const problem = voiceStepProblem(body);
    if (problem) {
      record.refused = 'bad_request';
      record.problem = problem;
      return sse(res, [JSON.stringify({ type: 'error', code: 'bad_request' })]);
    }
    record.locale = body.locale;
    record.messages = body.messages.length;
    record.contextChars = body.context.length;
    record.tools = body.tools.map((tool) => tool.name);
    if (state.speech.voice === 'quota') {
      record.refused = 'quota_frame';
      return sse(res, [JSON.stringify({ type: 'error', code: 'llm_quota_exhausted', resetsAt: new Date(Date.now() + 7 * DAY_MS).toISOString(), model: 'stub-voice' })]);
    }
    const decision = decideVoiceStep(body, { mode: state.speech.voice, memory: state.voiceMemory });
    record.script = decision.key;
    record.calls = decision.calls.map((call) => call.arguments?.action ?? call.name);
    const frames = [];
    if (decision.text) {
      const middle = Math.ceil(decision.text.length / 2);
      for (const piece of [decision.text.slice(0, middle), decision.text.slice(middle)]) if (piece) frames.push(JSON.stringify({ type: 'text-delta', text: piece }));
    }
    for (const call of decision.calls) {
      state.voiceCallCount += 1;
      frames.push(JSON.stringify({ type: 'tool-call', id: `vc_${state.voiceCallCount}`, name: call.name, arguments: JSON.stringify(call.arguments) }));
    }
    frames.push(JSON.stringify({ type: 'done' }));
    return sse(res, frames);
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
    const received = req.method === 'GET' ? { raw: Buffer.alloc(0), size: 0 } : await readRaw(req);
    const body = jsonOf(received);

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
    if (route === 'GET /desktop/speech/readiness') {
      const ready = READINESS[state.speech.readiness] ?? READINESS.ready;
      return json(res, 200, { listen: { ready: ready.listen }, speak: { ready: ready.speak }, voice: { ready: ready.voice }, silenceMs: 1500, startWaitMs: 6000, voiceSilenceMs: 900 });
    }
    if (route === 'POST /desktop/speech/transcribe') return transcribe(req, res, received, accountName);
    if (route === 'POST /desktop/speech/synthesize') return synthesize(res, body, accountName);
    if (route === 'POST /desktop/voice/step') return voiceStep(res, body, accountName);
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
  const fixturesFile = argValue(argv, '--fixtures');
  const connectorCommand = [nodeBin, path.join(HERE, 'stub-mcp-server.mjs'), '--log', mcpLog, '--marker', 'gate-stub-law'];
  const platform = createStubPlatform({
    accounts: defaultAccounts({ connectorCommand }),
    shape,
    log: (line) => { if (logFile) fs.appendFileSync(logFile, `${line}\n`); },
  });
  if (fixturesFile) {
    const map = JSON.parse(fs.readFileSync(fixturesFile, 'utf8'));
    const entries = Array.isArray(map?.fixtures) ? map.fixtures : [];
    platform.control({ speech: { transcripts: Object.fromEntries(entries.map((entry) => [entry.sha256, { name: entry.name, transcript: entry.transcript }])) } });
  }
  const bound = await platform.listen(port);
  process.stdout.write(`stub platform listening on 127.0.0.1:${bound}\n`);
  const stop = () => platform.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
