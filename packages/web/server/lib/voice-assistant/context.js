import path from 'node:path';

import { chromeSessionName } from '../mittrcraft-control/chrome-control.js';

export const VOICE_CONTEXT_MAX_CHARS = 8000;
export const VOICE_CHROME_SESSION_ID = 'voice';

const TITLE_MAX_CHARS = 200;
const URL_MAX_CHARS = 500;

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const clip = (value, max) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

const settle = async (work) => {
  try {
    return { ok: true, value: await work() };
  } catch {
    return { ok: false };
  }
};

export const createSessionLookup = ({ getClient }) => {
  const locate = async (client, sessionId, directoryHint) => {
    const listed = await settle(() => client.experimental.session.list({}));
    const sessions = listed.ok && Array.isArray(listed.value?.data) ? listed.value.data : [];
    const match = sessions.find((session) => session?.id === sessionId);
    if (match) return match;
    const fetched = await settle(() => client.session.get({ sessionID: sessionId, ...(directoryHint ? { directory: directoryHint } : {}) }));
    return fetched.ok && fetched.value?.data?.id === sessionId ? fetched.value.data : null;
  };

  const describe = async (sessionId, directoryHint) => {
    const id = asNonEmptyString(sessionId);
    if (!id) return null;
    const hint = asNonEmptyString(directoryHint);
    const clientResult = await settle(getClient);
    if (!clientResult.ok) return { found: false, id, directory: hint, status: 'unknown' };
    const client = clientResult.value;
    const session = await locate(client, id, hint);
    const directory = asNonEmptyString(session?.directory) || hint;
    if (!directory) return { found: Boolean(session), id, title: asNonEmptyString(session?.title), directory: null, status: 'unknown' };

    const [statuses, todos, permissions] = await Promise.all([
      settle(() => client.session.status({ directory })),
      settle(() => client.session.todo({ sessionID: id, directory })),
      settle(() => client.permission.list({ directory })),
    ]);

    const statusMap = statuses.ok ? statuses.value?.data : null;
    const status = statusMap && typeof statusMap === 'object' && !Array.isArray(statusMap)
      ? (typeof statusMap[id]?.type === 'string' ? statusMap[id].type : 'idle')
      : 'unknown';
    const todoList = todos.ok && Array.isArray(todos.value?.data) ? todos.value.data.filter((todo) => todo?.status !== 'cancelled') : null;
    const permissionList = permissions.ok && Array.isArray(permissions.value?.data) ? permissions.value.data : null;

    return {
      found: Boolean(session),
      id,
      title: asNonEmptyString(session?.title),
      directory,
      status,
      todo: todoList ? { done: todoList.filter((todo) => todo?.status === 'completed').length, total: todoList.length } : null,
      pendingPermission: permissionList ? permissionList.some((request) => request?.sessionID === id) : null,
    };
  };

  return { describe };
};

export const createVoiceChromePage = ({ chromeControl, readSettings }) => {
  let opened = false;

  const note = (action, ok) => {
    if (action === 'chrome.close') opened = false;
    else if (action === 'chrome.open' && ok) opened = true;
  };

  const read = async () => {
    if (!opened || chromeControl?.available !== true) return null;
    const settings = (await settle(readSettings)).value ?? {};
    const runOptions = {
      sessionName: chromeSessionName(VOICE_CHROME_SESSION_ID),
      profile: asNonEmptyString(settings.agentChromeProfile) ?? 'Default',
      headed: settings.agentChromeHeaded === true,
    };
    const [url, title] = await Promise.all([
      settle(() => chromeControl.run(['get', 'url'], runOptions)),
      settle(() => chromeControl.run(['get', 'title'], runOptions)),
    ]);
    if (!url.ok) {
      opened = false;
      return null;
    }
    const pageUrl = asNonEmptyString(url.value?.url);
    if (!pageUrl || pageUrl === 'about:blank') return null;
    return { url: pageUrl, title: title.ok ? asNonEmptyString(title.value?.title) : null };
  };

  return { note, read };
};

const describeProject = (projects, directory) => {
  const dir = asNonEmptyString(directory);
  const resolved = dir ? path.resolve(dir) : null;
  const project = resolved
    ? projects.find((entry) => resolved === entry.path || resolved.startsWith(`${entry.path}${path.sep}`))
    : null;
  if (project) return `Project: ${clip(project.label, TITLE_MAX_CHARS)} (${clip(project.path, URL_MAX_CHARS)}); directory ${clip(resolved, URL_MAX_CHARS)}`;
  if (resolved) return `Project: none configured for this directory; directory ${clip(resolved, URL_MAX_CHARS)}`;
  return 'Project: no project is open';
};

const describeOpenSession = (session, queuedPrompts) => {
  if (!session) return 'Open session: no session is open';
  const parts = [
    `Open session: ${session.title ? `"${clip(session.title, TITLE_MAX_CHARS)}"` : 'untitled'} (sessionId ${session.id}${session.directory ? `, directory ${clip(session.directory, URL_MAX_CHARS)}` : ''})`,
    `status ${session.status}`,
    session.todo ? `todos ${session.todo.done} of ${session.todo.total} done` : 'todos unknown',
  ];
  if (session.pendingPermission === true) parts.push('a permission request is waiting; the person answers it on screen');
  else if (session.pendingPermission === null || session.pendingPermission === undefined) parts.push('permission requests unknown');
  if (Number.isInteger(queuedPrompts)) parts.push(`${queuedPrompts} ${queuedPrompts === 1 ? 'prompt' : 'prompts'} queued`);
  return parts.join('; ');
};

const describeChrome = (page) => {
  if (!page) return 'Chrome: no page open';
  return `Chrome: ${page.title ? `"${clip(page.title, TITLE_MAX_CHARS)}" ` : ''}${clip(page.url, URL_MAX_CHARS)}`;
};

export const createVoiceContextBuilder = ({ listProjects, describeSession, readChromePage, isBrowserMounted }) => async ({ directory, sessionId, queuedPrompts } = {}) => {
  const id = asNonEmptyString(sessionId);
  const [projects, session, page] = await Promise.all([
    settle(listProjects),
    id ? settle(() => describeSession(id, directory)) : Promise.resolve({ ok: true, value: null }),
    settle(readChromePage),
  ]);
  const lines = [
    describeProject(projects.ok && Array.isArray(projects.value) ? projects.value : [], directory),
    session.ok ? describeOpenSession(session.value, queuedPrompts) : `Open session: sessionId ${id}; status unknown`,
    page.ok ? describeChrome(page.value) : 'Chrome: unknown',
    `In-app browser: ${isBrowserMounted() ? 'open' : 'not open'}`,
  ];
  return lines.join('\n').slice(0, VOICE_CONTEXT_MAX_CHARS);
};
