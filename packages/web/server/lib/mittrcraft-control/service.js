import path from 'node:path';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { MittrCraftControlError, asControlError } from './error.js';
import { MITTRCRAFT_ALL_ACTIONS } from './actions.js';
import { writeScreenshot } from './screenshots.js';
import { chromeSessionName } from './chrome-control.js';

const APP_NAME_PATTERN = /^[\w .()&-]{1,80}$/;

const DEFAULT_WAIT_TIMEOUT_SECONDS = 600;
const MAX_WAIT_TIMEOUT_SECONDS = 86_400;
const WAIT_POLL_INTERVAL_MS = 500;
// One service, both capabilities: which tool asked is the caller's concern.
const CONTROL_ACTIONS = new Set(MITTRCRAFT_ALL_ACTIONS);
const SCHEDULE_TASK_ID_ACTIONS = new Set([
  'schedule.run',
  'schedule.delete',
  'schedule.toggle',
]);

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const positiveInteger = (value, fallback, field) => {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new MittrCraftControlError(`${field} must be a positive integer`, 400);
  }
  return number;
};

const normalizeWaitTimeoutMs = (value) => {
  const seconds = value === undefined || value === null ? DEFAULT_WAIT_TIMEOUT_SECONDS : Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_WAIT_TIMEOUT_SECONDS) {
    throw new MittrCraftControlError(`timeout must be from 1 to ${MAX_WAIT_TIMEOUT_SECONDS} seconds`, 400);
  }
  return seconds * 1000;
};

const extractTextMessages = (messages, role = 'all') => {
  const result = [];
  for (const record of Array.isArray(messages) ? messages : []) {
    const info = record?.info;
    const messageRole = info?.role;
    if ((messageRole !== 'user' && messageRole !== 'assistant') || (role !== 'all' && role !== messageRole)) continue;
    const text = Array.isArray(record?.parts)
      ? record.parts.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('').trim()
      : '';
    if (!text) continue;
    const providerID = asNonEmptyString(info.providerID);
    const modelID = asNonEmptyString(info.modelID);
    result.push({
      id: asNonEmptyString(info.id) || '',
      role: messageRole,
      createdAt: Number.isFinite(info?.time?.created) ? info.time.created : null,
      completedAt: Number.isFinite(info?.time?.completed) ? info.time.completed : null,
      model: providerID && modelID ? `${providerID}/${modelID}` : null,
      text,
    });
  }
  return result.sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
};

const parseModel = (value) => {
  const model = asNonEmptyString(value);
  if (!model) throw new MittrCraftControlError('model is required', 400);
  const slashIndex = model.indexOf('/');
  if (slashIndex <= 0 || slashIndex === model.length - 1) {
    throw new MittrCraftControlError('model must be in provider/model format', 400);
  }
  return { providerID: model.slice(0, slashIndex), modelID: model.slice(slashIndex + 1) };
};

const parseWeekdays = (value) => {
  const raw = asNonEmptyString(value);
  if (!raw) throw new MittrCraftControlError('weekly is required', 400);
  const weekdays = raw.split(',').map((entry) => Number.parseInt(entry.trim(), 10));
  if (weekdays.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > 6)) {
    throw new MittrCraftControlError('weekly must contain weekdays from 0 to 6', 400);
  }
  return Array.from(new Set(weekdays)).sort((a, b) => a - b);
};

const buildSchedule = (input) => {
  const daily = asNonEmptyString(input.daily);
  const weekly = asNonEmptyString(input.weekly);
  const once = asNonEmptyString(input.once);
  const cron = asNonEmptyString(input.cron);
  const selectors = [daily, weekly, once, cron].filter(Boolean);
  if (selectors.length !== 1) {
    throw new MittrCraftControlError('Provide exactly one of daily, weekly, once, or cron', 400);
  }
  const timezone = asNonEmptyString(input.timezone);
  if (daily) return { kind: 'daily', times: [daily], ...(timezone ? { timezone } : {}) };
  if (weekly) {
    const time = asNonEmptyString(input.time);
    if (!time) throw new MittrCraftControlError('time is required with weekly', 400);
    return { kind: 'weekly', weekdays: parseWeekdays(weekly), times: [time], ...(timezone ? { timezone } : {}) };
  }
  if (once) {
    const time = asNonEmptyString(input.time);
    if (!time) throw new MittrCraftControlError('time is required with once', 400);
    return { kind: 'once', date: once, time, ...(timezone ? { timezone } : {}) };
  }
  return { kind: 'cron', cron, ...(timezone ? { timezone } : {}) };
};

const buildScheduledTask = (input) => {
  const name = asNonEmptyString(input.name);
  const prompt = asNonEmptyString(input.prompt);
  if (!name) throw new MittrCraftControlError('name is required', 400);
  if (!prompt) throw new MittrCraftControlError('prompt is required', 400);
  const model = parseModel(input.model);
  const goalTokenBudget = input.goalTokenBudget;
  if (goalTokenBudget !== undefined && input.goal !== true) {
    throw new MittrCraftControlError('goalTokenBudget requires goal', 400);
  }
  if (goalTokenBudget !== undefined && (!Number.isSafeInteger(goalTokenBudget) || goalTokenBudget < 1000 || goalTokenBudget > 100_000_000)) {
    throw new MittrCraftControlError('goalTokenBudget must be from 1000 to 100000000', 400);
  }
  return {
    name,
    enabled: input.disabled !== true,
    schedule: buildSchedule(input),
    execution: {
      prompt,
      ...model,
      ...(asNonEmptyString(input.agent) ? { agent: input.agent.trim() } : {}),
      ...(asNonEmptyString(input.variant) ? { variant: input.variant.trim() } : {}),
      ...(input.goal === true ? { goalEnabled: true } : {}),
      ...(goalTokenBudget !== undefined ? { goalTokenBudget } : {}),
    },
  };
};

export const createMittrCraftControlService = (dependencies) => {
  const {
    readSettingsFromDiskMigrated,
    sanitizeProjects,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    waitForOpenCodeReady,
    sessionService,
    scheduledTaskService,
    browserControl = null,
    computerControl = null,
    chromeControl = null,
    persistSettings = async () => {},
    // A function, not a value: brokerBaseUrl/ensureFreshSession only exist once the Mittr
    // shim has started, which happens after this service is constructed. Reading through a
    // getter means the wiring in index.js can fill this in later without this file caring
    // about that ordering.
    getJiraControl = () => null,
    getPlaneControl = () => null,
    createClient = createOpencodeClient,
    sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
    now = Date.now,
    // Plain `open -a`, not cua-driver: launching an app needs no Accessibility or
    // Screen Recording grant, so it does not belong behind the same binary as the
    // other computer.* actions and works even where cua-driver is unavailable.
    launchApp = (name) => new Promise((resolve, reject) => {
      const child = spawn('open', ['-a', name], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `open -a "${name}" exited with code ${code}`));
      });
    }),
  } = dependencies;

  const wait = (duration, signal) => {
    if (!signal) return sleep(duration);
    if (signal.aborted) return Promise.reject(new MittrCraftControlError('MittrCraft action was cancelled', 499));
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new MittrCraftControlError('MittrCraft action was cancelled', 499));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      sleep(duration).then(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      });
    });
  };

  const getClient = async () => {
    if (typeof waitForOpenCodeReady === 'function') await waitForOpenCodeReady(10_000, 250);
    return createClient({
      baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
      headers: getOpenCodeAuthHeaders(),
    });
  };

  const projects = async () => {
    const settings = await readSettingsFromDiskMigrated();
    return sanitizeProjects(settings?.projects || []).map((project) => ({
      id: project.id,
      path: path.resolve(project.path),
      label: asNonEmptyString(project.label) || path.basename(project.path) || project.path,
    }));
  };

  const models = async () => {
    const settings = await readSettingsFromDiskMigrated();
    return {
      defaultModel: asNonEmptyString(settings?.defaultModel),
      defaultVariant: asNonEmptyString(settings?.defaultVariant),
      defaultAgent: asNonEmptyString(settings?.defaultAgent),
      favoriteModels: Array.isArray(settings?.favoriteModels) ? settings.favoriteModels : [],
      recentModels: Array.isArray(settings?.recentModels) ? settings.recentModels : [],
    };
  };

  const sessionStatus = async (client, sessionID, directory) => {
    const response = await client.session.status({ directory });
    const statuses = response?.data;
    if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) {
      throw new MittrCraftControlError('Invalid session status response', 500);
    }
    return statuses[sessionID] || { type: 'idle' };
  };

  const sessionMessages = async (client, sessionID, directory, role, limit) => {
    const fetchLimit = limit === undefined ? undefined : Math.max(100, limit * 4);
    let response = await client.session.messages({ sessionID, directory, ...(fetchLimit ? { limit: fetchLimit } : {}) });
    let raw = Array.isArray(response?.data) ? response.data : [];
    let messages = extractTextMessages(raw, role);
    if (limit !== undefined && messages.length < limit && raw.length >= fetchLimit) {
      response = await client.session.messages({ sessionID, directory });
      raw = Array.isArray(response?.data) ? response.data : [];
      messages = extractTextMessages(raw, role);
    }
    return limit === undefined ? messages : messages.slice(-limit);
  };

  const waitForIdle = async ({ client, sessionID, directory, timeoutMs, requireActivity, baselineMessageID, startedAt, signal }) => {
    const deadline = now() + timeoutMs;
    let observedActivity = false;
    while (true) {
      if (signal?.aborted) throw new MittrCraftControlError('MittrCraft action was cancelled', 499);
      const status = await sessionStatus(client, sessionID, directory);
      if (status.type === 'busy' || status.type === 'retry') {
        observedActivity = true;
      } else if (!requireActivity || observedActivity) {
        return status;
      } else {
        const messages = await sessionMessages(client, sessionID, directory, 'assistant', 1);
        const message = messages[0];
        if (message?.completedAt && (baselineMessageID ? message.id !== baselineMessageID : message.completedAt >= startedAt)) {
          return status;
        }
      }
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new MittrCraftControlError(`Session did not become idle within ${Math.ceil(timeoutMs / 1000)} seconds`, 500);
      }
      await wait(Math.min(WAIT_POLL_INTERVAL_MS, remaining), signal);
    }
  };

  // session.send/fork default the directory to the caller's context directory,
  // which is wrong for sessions living in other worktrees: prompt_async then
  // targets an instance that does not hold the session and the run dies with
  // UnknownError. Resolve the target session's directory from the global
  // session list when the caller did not scope explicitly.
  const resolveSessionDirectory = async (sessionID) => {
    try {
      const client = await getClient();
      const response = await client.experimental?.session?.list?.({});
      const sessions = Array.isArray(response?.data) ? response.data : [];
      const session = sessions.find((item) => item?.id === sessionID);
      return asNonEmptyString(session?.directory) || null;
    } catch {
      return null;
    }
  };

  const executeSessionAction = async (action, input, contextDirectory, signal) => {
    if (input.timeout !== undefined && input.wait !== true) throw new MittrCraftControlError('timeout requires wait', 400);
    if (input.lastAssistant === true && input.wait !== true) throw new MittrCraftControlError('lastAssistant requires wait', 400);
    const sessionID = asNonEmptyString(input.sessionId);
    let directory = asNonEmptyString(input.directory) || (!input.projectId ? asNonEmptyString(contextDirectory) : null);
    if (sessionID && action !== 'session.create' && !asNonEmptyString(input.directory) && !input.projectId) {
      const resolvedSessionDirectory = await resolveSessionDirectory(sessionID);
      if (resolvedSessionDirectory) directory = resolvedSessionDirectory;
    }
    const payload = {
      ...(directory ? { directory } : {}),
      ...(asNonEmptyString(input.projectId) ? { projectId: input.projectId.trim() } : {}),
      ...(asNonEmptyString(input.title) ? { title: input.title.trim() } : {}),
      ...(asNonEmptyString(input.prompt) ? { prompt: input.prompt.trim() } : {}),
      ...(asNonEmptyString(input.model) ? { model: input.model.trim() } : {}),
      ...(asNonEmptyString(input.agent) ? { agent: input.agent.trim() } : {}),
      ...(asNonEmptyString(input.variant) ? { variant: input.variant.trim() } : {}),
      ...(input.goal === true ? { goal: true } : {}),
      ...(input.goalTokenBudget !== undefined ? { goalTokenBudget: input.goalTokenBudget } : {}),
      ...(asNonEmptyString(input.worktree) ? { worktree: {
        name: input.worktree.trim(),
        ...(asNonEmptyString(input.branch) ? { branchName: input.branch.trim() } : {}),
        ...(asNonEmptyString(input.startRef) ? { startRef: input.startRef.trim() } : {}),
      } } : {}),
      ...(typeof input.setUpstream === 'boolean' ? { setUpstream: input.setUpstream } : {}),
      ...(asNonEmptyString(input.messageId) ? { messageId: input.messageId.trim() } : {}),
    };
    const startedAt = now();
    let result;
    if (action === 'session.create') {
      result = await sessionService.create(payload);
    } else {
      if (!sessionID) throw new MittrCraftControlError('sessionId is required', 400);
      if (action === 'session.send') {
        result = await sessionService.send(sessionID, payload);
      } else {
        result = await sessionService.fork(sessionID, payload);
      }
    }
    if (input.wait !== true) {
      const publicResult = { ...result };
      delete publicResult.baselineAssistantMessageId;
      return publicResult;
    }
    const client = await getClient();
    const status = await waitForIdle({
      client,
      sessionID: result.sessionId,
      directory: result.directory,
      timeoutMs: normalizeWaitTimeoutMs(input.timeout),
      requireActivity: result.promptDispatched === true,
      baselineMessageID: result.baselineAssistantMessageId,
      startedAt,
      signal,
    });
    const publicResult = { ...result, sessionStatus: status };
    delete publicResult.baselineAssistantMessageId;
    if (input.lastAssistant === true) {
      publicResult.lastAssistantMessage = (await sessionMessages(client, result.sessionId, result.directory, 'assistant', 1))[0] || null;
    }
    return publicResult;
  };

  /**
   * Validates browser inputs here rather than in the renderer: an invalid call
   * should come back as a usage error the agent can correct, without waking a
   * client or waiting for a round trip.
   */
  const browserAction = async (action, input, signal, contextDirectory) => {
    const parameters = {};

    const readViewport = (required) => {
      const viewport = asNonEmptyString(input.viewport);
      if (!viewport) {
        if (required) throw new MittrCraftControlError('viewport is required for browser.resize', 400);
        return;
      }
      if (!['mobile', 'tablet', 'desktop', 'fill'].includes(viewport)) {
        throw new MittrCraftControlError('viewport must be mobile, tablet, desktop, or fill', 400);
      }
      parameters.viewport = viewport;
    };

    if (action === 'browser.resize') readViewport(true);

    if (action === 'browser.capture') {
      const label = asNonEmptyString(input.label);
      if (label) parameters.label = label;
    }

    if (action === 'browser.open') {
      readViewport(false);
      const url = asNonEmptyString(input.url);
      if (!url) throw new MittrCraftControlError('url is required for browser.open', 400);
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw new MittrCraftControlError('url must be an absolute http(s) URL', 400);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new MittrCraftControlError('url must use http or https', 400);
      }
      parameters.url = parsed.toString();
    }


    if (action === 'browser.click') {
      const selector = asNonEmptyString(input.selector);
      const text = asNonEmptyString(input.text);
      if (!selector && !text) {
        throw new MittrCraftControlError('browser.click requires selector or text', 400);
      }
      if (selector) parameters.selector = selector;
      if (text) parameters.text = text;
    }

    if (action === 'browser.snapshot') {
      const selector = asNonEmptyString(input.selector);
      if (selector) parameters.selector = selector;
    }

    if (action === 'browser.inspect') {
      const selector = asNonEmptyString(input.selector);
      if (!selector) throw new MittrCraftControlError('selector is required for browser.inspect', 400);
      parameters.selector = selector;
    }

    if (action === 'browser.type') {
      const selector = asNonEmptyString(input.selector);
      if (!selector) throw new MittrCraftControlError('selector is required for browser.type', 400);
      if (typeof input.value !== 'string') {
        throw new MittrCraftControlError('value is required for browser.type', 400);
      }
      parameters.selector = selector;
      parameters.value = input.value;
      parameters.submit = input.submit === true;
    }

    if (action === 'browser.scroll') {
      const selector = asNonEmptyString(input.selector);
      const direction = asNonEmptyString(input.direction);
      if (!selector && !direction) {
        throw new MittrCraftControlError('browser.scroll requires direction or selector', 400);
      }
      if (direction && !['up', 'down', 'top', 'bottom'].includes(direction)) {
        throw new MittrCraftControlError('direction must be up, down, top, or bottom', 400);
      }
      if (selector) parameters.selector = selector;
      if (direction) parameters.direction = direction;
    }

    // Opening a page waits for the navigation to settle, so its budget has to
    // exceed the client's own wait; sharing one timeout with the quick actions
    // made a slow page indistinguishable from an unreachable browser.
    const timeoutMs = action === 'browser.open' ? 45_000 : 20_000;
    const result = await browserControl.request(action, parameters, { signal, timeoutMs });

    // The image is written here rather than in the renderer: the file belongs
    // beside the code it documents, and the client that took it may be on a
    // different machine than the repository.
    if (action === 'browser.capture') {
      const directory = asNonEmptyString(input.directory) || asNonEmptyString(contextDirectory);
      if (!directory) {
        throw new MittrCraftControlError('directory is required to save a screenshot', 400);
      }
      const capture = result && typeof result === 'object' ? result : {};
      const saved = await writeScreenshot({
        directory,
        base64: capture.base64,
        mime: capture.mime,
        label: input.label,
      });
      // The path is what an answer, a commit, or a review can actually use;
      // the base64 travels alongside it only as far as the agent-tool runtime,
      // which lifts it into an attachment instead of leaving it in this text.
      return {
        path: saved.path,
        // Saving the file only shows it to the user once the path is written
        // into a finished reply, which chat renders below that message — the
        // attachment is what lets the agent itself see the picture right now.
        hint: `The image is attached for you to view directly; write ![](${saved.path}) in your reply to also show it to the user.`,
        url: capture.url ?? null,
        title: capture.title ?? null,
        viewport: capture.viewport ?? null,
        width: capture.width ?? null,
        height: capture.height ?? null,
        imageBase64: capture.base64 ?? null,
        imageMime: capture.mime || 'image/png',
      };
    }

    return result;
  };

  /**
   * `list_apps` first so a name can be resolved to a pid: the model names an
   * app the way a person would ("MittrCraft"), never a pid it has no way to
   * know. Ambiguity (several windows for one pid) is reported rather than
   * guessed at, the same way the driver itself refuses rather than picks —
   * see `bring_to_front_exact_window_unverified` in its own output.
   */
  const computerAction = async (action, input, contextDirectory) => {
    if (action === 'computer.list_apps') {
      const result = await computerControl.request('list_apps');
      const apps = Array.isArray(result?.apps) ? result.apps : [];
      return {
        apps: apps.map((app) => ({
          name: app.name,
          pid: app.pid,
          running: app.running === true,
          bundleId: app.bundle_id ?? null,
        })),
      };
    }

    if (action === 'computer.open_app') {
      const name = asNonEmptyString(input.app);
      if (!name) throw new MittrCraftControlError('app is required for computer.open_app', 400);
      if (!APP_NAME_PATTERN.test(name)) throw new MittrCraftControlError('app must be a plain app name', 400);
      try {
        await launchApp(name);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        throw new MittrCraftControlError(`Could not open "${name}": ${message}`, 502);
      }
      return { launched: true, app: name };
    }

    if (action === 'computer.bring_to_front') {
      const name = asNonEmptyString(input.app);
      if (!name) throw new MittrCraftControlError('app is required for computer.bring_to_front', 400);
      if (!APP_NAME_PATTERN.test(name)) throw new MittrCraftControlError('app must be a plain app name', 400);
      const listed = await computerControl.request('list_apps');
      const apps = Array.isArray(listed?.apps) ? listed.apps : [];
      const match = apps.find((app) => app.running === true && String(app.name).toLowerCase() === name.toLowerCase());
      if (!match) throw new MittrCraftControlError(`No running app named "${name}"`, 404);
      const result = await computerControl.request('bring_to_front', { pid: match.pid });
      if (result?.code === 'ambiguous_window_target') {
        return {
          activated: false,
          reason: 'ambiguous_window_target',
          candidates: (result.candidates ?? []).map((c) => ({ windowId: c.window_id, title: c.title || null })),
          hint: 'Several windows belong to this app; this action does not pick one for you yet.',
        };
      }
      return {
        activated: result?.process_activated === true,
        windowVerified: result?.exact_window_effect?.verified === true,
      };
    }

    if (action === 'computer.screenshot') {
      const directory = asNonEmptyString(input.directory) || asNonEmptyString(contextDirectory);
      if (!directory) throw new MittrCraftControlError('directory is required to save a screenshot', 400);
      const result = await computerControl.request('get_desktop_state');
      const saved = await writeScreenshot({
        directory,
        base64: result?.screenshot_png_b64,
        mime: result?.screenshot_mime_type || 'image/png',
        label: 'desktop',
      });
      return {
        path: saved.path,
        hint: `The image is attached for you to view directly; write ![](${saved.path}) in your reply to also show it to the user.`,
        width: result?.screen_width ?? null,
        height: result?.screen_height ?? null,
        imageBase64: result?.screenshot_png_b64 ?? null,
        imageMime: result?.screenshot_mime_type || 'image/png',
      };
    }

    throw new MittrCraftControlError(`Unsupported computer action: ${action}`, 400);
  };

  const jiraAction = async (action, input) => {
    if (action !== 'jira.get_issue') {
      throw new MittrCraftControlError(`Unsupported Jira action: ${action}`, 400);
    }
    const key = asNonEmptyString(input.key);
    if (!key) throw new MittrCraftControlError('key is required for jira.get_issue', 400);
    const jiraControl = getJiraControl();
    if (!jiraControl) {
      throw new MittrCraftControlError('Mittr platform session is not available', 503);
    }
    try {
      return await jiraControl.getJiraIssue(key);
    } catch (error) {
      throw new MittrCraftControlError(
        error instanceof Error ? error.message : `Failed to read Jira issue ${key}`,
        Number(error?.statusCode) || 502,
      );
    }
  };

  const planeAction = async (action, input) => {
    if (action !== 'plane.get_issue') {
      throw new MittrCraftControlError(`Unsupported Plane action: ${action}`, 400);
    }
    const ref = asNonEmptyString(input.ref);
    if (!ref) throw new MittrCraftControlError('ref is required for plane.get_issue', 400);
    const planeControl = getPlaneControl();
    if (!planeControl) {
      throw new MittrCraftControlError('Mittr platform session is not available', 503);
    }
    try {
      return await planeControl.getPlaneIssue(ref);
    } catch (error) {
      throw new MittrCraftControlError(
        error instanceof Error ? error.message : `Failed to read Plane work item ${ref}`,
        Number(error?.statusCode) || 502,
      );
    }
  };

  const required = (value, name) => {
    const text = asNonEmptyString(value);
    if (!text) throw new MittrCraftControlError(`${name} is required`, 400);
    return text;
  };

  const hostOf = (url) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new MittrCraftControlError('url must be a full http(s) address', 400);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new MittrCraftControlError('Only http(s) pages can be opened in Chrome', 400);
    }
    return parsed.hostname.toLowerCase();
  };

  const CHROME_COMMANDS = {
    'chrome.snapshot': (input) => (asNonEmptyString(input.selector) ? ['snapshot', '-i', '-s', asNonEmptyString(input.selector)] : ['snapshot', '-i']),
    'chrome.read': () => ['read'],
    'chrome.click': (input) => ['click', required(input.ref, 'ref')],
    'chrome.fill': (input) => ['fill', required(input.ref, 'ref'), String(input.value ?? '')],
    'chrome.type': (input) => ['type', required(input.ref, 'ref'), String(input.value ?? '')],
    'chrome.press': (input) => ['press', required(input.key, 'key')],
    'chrome.select': (input) => ['select', required(input.ref, 'ref'), required(input.value, 'value')],
    'chrome.wait': (input) => (asNonEmptyString(input.text) ? ['wait', '--text', asNonEmptyString(input.text)] : ['wait', required(input.ref, 'ref')]),
  };

  const chromeAction = async (action, input, contextDirectory, options = {}) => {
    const sessionId = asNonEmptyString(options.sessionId);
    if (!sessionId) throw new MittrCraftControlError('The Chrome tool needs the calling session', 400);
    const settings = (await readSettingsFromDiskMigrated()) ?? {};
    const profile = asNonEmptyString(settings.agentChromeProfile);
    const runOptions = {
      sessionName: chromeSessionName(sessionId),
      profile: profile ?? 'Default',
      headed: settings.agentChromeHeaded === true,
      signal: options.signal,
    };

    if (action === 'chrome.close') {
      await chromeControl.run(['close'], runOptions).catch(() => undefined);
      return { closed: true };
    }
    if (!chromeControl.chromeInstalled()) {
      throw new MittrCraftControlError('Google Chrome is not installed on this Mac; ask the user to install it', 503);
    }
    if (!profile) {
      throw new MittrCraftControlError('No Chrome profile is chosen yet; ask the user to choose a Chrome profile in Settings → MittrCraft tools', 409);
    }

    const approved = Array.isArray(settings.agentChromeApprovedHosts) ? settings.agentChromeApprovedHosts : [];
    const ensureApproved = async (host) => {
      if (approved.includes(host)) return;
      if (asNonEmptyString(options.approveHost) === host) {
        await persistSettings({ agentChromeApprovedHosts: [...approved, host] });
        return;
      }
      throw new MittrCraftControlError(
        `The user has not yet allowed using their Chrome sign-in on ${host}`,
        403,
        { code: 'site_approval_required', host },
      );
    };

    const runAction = async (command) => {
      try {
        return await chromeControl.run(command, runOptions);
      } catch (error) {
        if (options.signal?.aborted) {
          await chromeControl.run(['close'], { ...runOptions, signal: undefined }).catch(() => undefined);
        }
        throw error;
      }
    };

    if (action === 'chrome.open') {
      const url = required(input.url, 'url');
      await ensureApproved(hostOf(url));
      return runAction(['open', url]);
    }

    const current = await chromeControl.run(['get', 'url'], runOptions);
    const currentUrl = asNonEmptyString(current?.url);
    if (!currentUrl || currentUrl === 'about:blank') {
      throw new MittrCraftControlError('No page is open in this session; call chrome.open first', 400);
    }
    await ensureApproved(hostOf(currentUrl));

    if (action === 'chrome.screenshot') {
      const directory = asNonEmptyString(input.directory) || asNonEmptyString(contextDirectory);
      if (!directory) throw new MittrCraftControlError('directory is required to save a screenshot', 400);
      const scratch = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'mittrcraft-chrome-'));
      try {
        const file = path.join(scratch, 'page.png');
        await runAction(['screenshot', file]);
        const base64 = (await fsPromises.readFile(file)).toString('base64');
        const saved = await writeScreenshot({ directory, base64, mime: 'image/png', label: input.label || 'chrome' });
        return {
          path: saved.path,
          hint: `The image is attached for you to view directly; write ![](${saved.path}) in your reply to also show it to the user.`,
          url: currentUrl,
          imageBase64: base64,
          imageMime: 'image/png',
        };
      } finally {
        await fsPromises.rm(scratch, { recursive: true, force: true });
      }
    }

    const build = CHROME_COMMANDS[action];
    if (!build) throw new MittrCraftControlError(`Unsupported Chrome action: ${action}`, 400);
    return runAction(build(input));
  };

  const chromeProfiles = async () => {
    if (!chromeControl?.available) return [];
    return chromeControl.profiles();
  };

  const execute = async (action, input = {}, contextDirectory, options = {}) => {
    try {
      if (!CONTROL_ACTIONS.has(action)) {
        throw new MittrCraftControlError(`Unsupported MittrCraft action: ${action || 'missing'}`, 400);
      }
      if (action.startsWith('browser.')) {
        if (!browserControl) {
          throw new MittrCraftControlError('The in-app browser is not available on this server', 503);
        }
        return browserAction(action, input, options.signal, contextDirectory);
      }
      if (action.startsWith('computer.')) {
        if (!computerControl || computerControl.available !== true) {
          throw new MittrCraftControlError('Computer use is not available on this build', 503);
        }
        return computerAction(action, input, contextDirectory);
      }
      if (action.startsWith('chrome.')) {
        if (!chromeControl || chromeControl.available !== true) {
          throw new MittrCraftControlError('The Chrome tool is not bundled in this build of MittrCraft', 503);
        }
        return chromeAction(action, input, contextDirectory, options);
      }
      if (action.startsWith('jira.')) {
        return jiraAction(action, input);
      }
      if (action.startsWith('plane.')) {
        return planeAction(action, input);
      }
      if (action === 'projects.list') return { projects: await projects() };
      if (action === 'models.list') return models();
      if (action === 'schedule.status') return scheduledTaskService.status();
      if (action.startsWith('schedule.')) {
        const taskID = asNonEmptyString(input.taskId);
        if (SCHEDULE_TASK_ID_ACTIONS.has(action) && !taskID) {
          throw new MittrCraftControlError('taskId is required', 400);
        }
        const explicitProjectID = asNonEmptyString(input.projectId);
        const explicitDirectory = asNonEmptyString(input.directory);
        const contextDirectoryFallback = explicitProjectID
          ? undefined
          : asNonEmptyString(contextDirectory) || undefined;
        const projectID = await scheduledTaskService.resolveProjectID({
          projectId: explicitProjectID || undefined,
          directory: explicitDirectory || contextDirectoryFallback,
        });
        switch (action) {
          case 'schedule.list':
            return { scheduler: await scheduledTaskService.status(), tasks: await scheduledTaskService.list(projectID) };
          case 'schedule.create': {
            const result = await scheduledTaskService.upsert(projectID, buildScheduledTask(input));
            return { task: result.task, created: result.created };
          }
          case 'schedule.run':
            return scheduledTaskService.run(projectID, taskID);
          case 'schedule.delete':
            return { deleted: true, tasks: await scheduledTaskService.remove(projectID, taskID) };
          case 'schedule.toggle': {
            if (typeof input.disabled !== 'boolean') {
              throw new MittrCraftControlError('disabled is required for schedule.toggle', 400);
            }
            const enabled = input.disabled === false;
            return { task: await scheduledTaskService.setEnabled(projectID, taskID, enabled), enabled };
          }
        }
      }
      if (action === 'session.create' || action === 'session.send' || action === 'session.fork') {
        return executeSessionAction(action, input, contextDirectory, options.signal);
      }
      if (action.startsWith('session.')) {
        const directory = asNonEmptyString(input.directory) || asNonEmptyString(contextDirectory);
        const sessionID = asNonEmptyString(input.sessionId);
        const client = await getClient();
        if (action === 'session.list') {
          const limit = positiveInteger(input.limit, 10, 'limit');
          const response = await client.session.list(directory ? { directory } : {});
          let sessions = Array.isArray(response?.data) ? response.data : [];
          if (input.all !== true) sessions = sessions.filter((session) => !session?.time?.archived);
          sessions = sessions.slice(0, limit);
          if (input.withStatus === true) {
            const cache = new Map();
            sessions = await Promise.all(sessions.map(async (session) => {
              const sessionDirectory = asNonEmptyString(session?.directory);
              if (!sessionDirectory) return { ...session, status: { type: 'unknown' } };
              if (!cache.has(sessionDirectory)) {
                const statusRequest = client.session.status({ directory: sessionDirectory }).catch(() => null);
                cache.set(sessionDirectory, statusRequest);
              }
              const statusResponse = await cache.get(sessionDirectory);
              return { ...session, status: statusResponse?.data?.[session.id] || (statusResponse ? { type: 'idle' } : { type: 'unknown' }) };
            }));
          }
          return { sessions, limit, directory, archived: input.all === true ? 'included' : 'excluded' };
        }
        if (!sessionID) throw new MittrCraftControlError('sessionId is required', 400);
        if (!directory) throw new MittrCraftControlError('directory is required', 400);
        if (action === 'session.status') {
          return { sessionId: sessionID, directory, sessionStatus: await sessionStatus(client, sessionID, directory) };
        }
        if (action === 'session.messages') {
          if (input.timeout !== undefined && input.wait !== true) throw new MittrCraftControlError('timeout requires wait', 400);
          const role = input.lastAssistant === true ? 'assistant' : (asNonEmptyString(input.role) || 'all');
          if (!['all', 'user', 'assistant'].includes(role)) throw new MittrCraftControlError('role must be all, user, or assistant', 400);
          const last = input.last === true || input.lastAssistant === true;
          if (input.all === true && (last || input.limit !== undefined)) throw new MittrCraftControlError('all cannot be combined with last or limit', 400);
          if (last && input.limit !== undefined) throw new MittrCraftControlError('last cannot be combined with limit', 400);
          const currentStatus = input.wait === true
            ? await waitForIdle({ client, sessionID, directory, timeoutMs: normalizeWaitTimeoutMs(input.timeout), requireActivity: false, startedAt: now(), signal: options.signal })
            : await sessionStatus(client, sessionID, directory);
          const limit = input.all === true ? undefined : (last ? 1 : positiveInteger(input.limit, 10, 'limit'));
          return { sessionId: sessionID, directory, role, sessionStatus: currentStatus, messages: await sessionMessages(client, sessionID, directory, role, limit) };
        }
      }
      throw new MittrCraftControlError(`Unsupported MittrCraft action: ${action || 'missing'}`, 400);
    } catch (error) {
      throw asControlError(error, `Failed to execute ${action || 'MittrCraft action'}`);
    }
  };

  return { execute, chromeProfiles };
};
