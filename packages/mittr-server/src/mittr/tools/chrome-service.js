import dns from 'node:dns';
import fsPromises from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { profileOf } from '../mittr-settings.js';
import { ACCOUNT_CHANGED } from '../platform.js';
import { trimmedText } from '../values.js';
import { MAX_GOAL_CHARS } from './browser-stepper.js';
import { MITTR_TOOLS, MittrToolError } from './registry.js';
import { chromeSessionName } from './chrome-control.js';
import { NO_SCREENSHOT_DIRECTORY, imageOf, saveScreenshot, screenshotHint } from './screenshots.js';

const DESCRIPTION_SENTENCES = Object.freeze([
  [() => true, "Use a Chrome session that starts from the user's own Chrome profile, for sites the user is already signed in to in Chrome (Plane, Jira, internal tools) and for web work that should not take over MittrCraft's browser panel."],
  [({ webTool }) => webTool, 'To look at the app being built, use openchamber_web instead.'],
  [({ doTask }) => doTask, 'Use one action per call: chrome.open a page, then either chrome.do with the goal to let MittrCraft work through the page step by step on its own (fastest for filling forms and clicking through flows), or chrome.snapshot to get refs and act on them yourself.'],
  [({ doTask }) => !doTask, 'Use one action per call: chrome.open a page, then chrome.snapshot to get refs and act on them yourself.'],
  [({ doTask }) => doTask, 'If chrome.do stops to ask, ask the user; do not guess.'],
  [() => true, 'The first time you open a site the user is asked whether you may use their sign-in there.'],
  [() => true, 'If a page asks you to sign in, stop and tell the user which site — never type a password or fill a sign-in form.'],
]);

export const chromeToolDescription = ({ webTool = false, doTask = false } = {}) => DESCRIPTION_SENTENCES
  .filter(([applies]) => applies({ webTool, doTask }))
  .map(([, sentence]) => sentence)
  .join(' ');

const PAGE_PARAMETERS = Object.freeze({
  url: { type: 'string', description: 'http(s) URL for chrome.open' },
  ref: { type: 'string', description: 'Element ref from the last chrome.snapshot, such as @e3' },
  value: { type: 'string', description: 'Text for chrome.fill or chrome.type, or the option for chrome.select' },
  key: { type: 'string', description: 'Key for chrome.press, such as Enter or Control+a' },
  text: { type: 'string', description: 'Text to wait for with chrome.wait' },
  selector: { type: 'string', description: 'CSS selector to read only part of the page in chrome.snapshot' },
  label: { type: 'string', description: 'Short name for a chrome.screenshot image' },
});

const TASK_PARAMETERS = Object.freeze({
  goal: { type: 'string', description: 'For chrome.do: what to get done on the open page, in the user\'s own words and with every value it needs' },
  maxSteps: { type: 'integer', minimum: 1, maximum: 40, description: 'For chrome.do: most steps to take before stopping (default 15)' },
});

export const chromeToolParameters = ({ doTask = false } = {}) => (doTask ? { ...PAGE_PARAMETERS, ...TASK_PARAMETERS } : { ...PAGE_PARAMETERS });

const DEFINITIONS = Object.freeze([
  { action: 'chrome.open', effect: 'read', title: 'Open a page in Chrome', description: 'Open url in a Chrome session that starts from the user\'s chosen Chrome profile, so sites they are signed in to stay signed in. The first use on a site asks the user' },
  { action: 'chrome.snapshot', effect: 'read', title: 'Read the Chrome page', description: 'Interactive elements of the open page with refs (@e1) the other chrome actions take; pass selector to read one part' },
  { action: 'chrome.read', effect: 'read', title: 'Read the Chrome page as text', description: 'The open page as readable markdown text' },
  { action: 'chrome.click', effect: 'change', title: 'Click in Chrome', description: 'Click the element with ref from the last snapshot' },
  { action: 'chrome.fill', effect: 'change', title: 'Fill a field in Chrome', description: 'Clear the field with ref and fill it with value' },
  { action: 'chrome.type', effect: 'change', title: 'Type in Chrome', description: 'Type value into the field with ref without clearing it' },
  { action: 'chrome.press', effect: 'change', title: 'Press a key in Chrome', description: 'Press key, such as Enter, Tab or Control+a' },
  { action: 'chrome.select', effect: 'change', title: 'Choose an option in Chrome', description: 'Choose value in the dropdown with ref, by value or visible label' },
  { action: 'chrome.wait', effect: 'read', title: 'Wait in Chrome', description: 'Wait until text appears on the page, or until the element with ref appears' },
  { action: 'chrome.screenshot', effect: 'read', title: 'Screenshot the Chrome page', description: 'Save the visible page as an image in the project and see it directly when it is small enough to attach; pass label to name it' },
  { action: 'chrome.do', effect: 'change', title: 'Do a task on the Chrome page', description: 'Give goal in plain words and MittrCraft works through the open page on its own, one step at a time (click, fill, choose), until the goal is done, it needs to ask the user, or maxSteps runs out. Returns every step it took and where it stopped. chrome.open the page first' },
  { action: 'chrome.close', effect: 'change', title: 'Close the Chrome session', description: 'Close this session\'s Chrome; no parameters' },
]);

const notYetAllowed = (host) => new MittrToolError(`The user has not yet allowed using their Chrome sign-in on ${host}`, 403, { code: 'site_approval_required', host });

export const NO_APPROVALS = Object.freeze({
  isApproved: async () => false,
  ask: async ({ host }) => {
    throw notYetAllowed(host);
  },
  replied: () => {},
  forgetSession: () => {},
  forgetAll: () => {},
  removeHost: async () => [],
});

const NO_PAGE = 'about:blank';
const DEFAULT_PROFILE = 'Default';
const OWN_ADDRESS = 'That address is MittrCraft itself';
const PROFILE_REQUIRED = 'No Chrome profile is chosen yet; ask the user to choose one in Settings → Integrations → MittrCraft tools → Chrome profile';
const NOT_A_PROFILE = 'The chosen Chrome profile is not one of this Mac\'s Chrome profiles; ask the user to choose one in Settings → Integrations → MittrCraft tools → Chrome profile';
const NO_PAGE_OPEN = 'No page is open in this session; call chrome.open first';
const OWN_LOOKUP_TIMEOUT_MS = 1_500;
const NO_STEPPER = 'chrome.do needs the Mittr platform; ask the user to sign in to Mittr, or work step by step with chrome.snapshot';
const CALL_CANCELLED = 'the call was cancelled';
const GOAL_TOO_LONG = `goal is too long for chrome.do; say it in at most ${MAX_GOAL_CHARS} characters`;
const DEFAULT_TASK_STEPS = 15;
const MAX_TASK_STEPS = 40;
const STEP_ACTIONS = Object.freeze({ click: 'chrome.click', fill: 'chrome.fill', select: 'chrome.select' });

const required = (value, name) => {
  const text = trimmedText(value);
  if (!text) throw new MittrToolError(`${name} is required`, 400);
  return text;
};

const pageOf = (url) => {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new MittrToolError('url must be a full http(s) address', 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new MittrToolError('Only http(s) pages can be opened in Chrome', 400);
  }
  return parsed;
};

const refOf = (value) => {
  const match = /^@?(e\d+)$/.exec(trimmedText(value) ?? '');
  if (!match) throw new MittrToolError('ref must be an element ref from chrome.snapshot, such as @e3', 400);
  return `@${match[1]}`;
};

const keyOf = (value) => {
  const key = trimmedText(value) ?? '';
  if (!/^[A-Za-z0-9]+(\+[A-Za-z0-9]+)*$/.test(key)) {
    throw new MittrToolError('key must be a key name such as Enter, Tab or Control+a', 400);
  }
  return key;
};

const plainArg = (value, name, { allowEmpty = false } = {}) => {
  const text = String(value ?? '');
  if (!allowEmpty && text.trim().length === 0) throw new MittrToolError(`${name} is required`, 400);
  if (text.startsWith('-')) throw new MittrToolError(`${name} cannot start with "-"`, 400);
  return text;
};

const CHROME_COMMANDS = {
  'chrome.snapshot': (input) => (trimmedText(input.selector) ? ['snapshot', '-i', '-s', plainArg(input.selector, 'selector')] : ['snapshot', '-i']),
  'chrome.read': () => ['read'],
  'chrome.click': (input) => ['click', refOf(input.ref)],
  'chrome.fill': (input) => ['fill', refOf(input.ref), plainArg(input.value, 'value', { allowEmpty: true })],
  'chrome.type': (input) => ['type', refOf(input.ref), plainArg(input.value, 'value', { allowEmpty: true })],
  'chrome.press': (input) => ['press', keyOf(input.key)],
  'chrome.select': (input) => ['select', refOf(input.ref), plainArg(input.value, 'value')],
  'chrome.wait': (input) => (trimmedText(input.text) ? ['wait', '--text', plainArg(input.text, 'text')] : ['wait', refOf(input.ref)]),
};

const ipv4OfMapped = (host) => {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!hex) return host;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
};

const normalizedHost = (hostname) => ipv4OfMapped(String(hostname).toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.+$/, ''));

const isLoopbackOrUnspecified = (address) => {
  const host = normalizedHost(address);
  return host === 'localhost' || host.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(host) || host === '0.0.0.0' || host === '::1' || host === '::';
};

const taskStepLimit = (value) => {
  const asked = Number(value);
  return Number.isInteger(asked) && asked > 0 ? Math.min(asked, MAX_TASK_STEPS) : DEFAULT_TASK_STEPS;
};

const stepLine = (step) => {
  const target = trimmedText(step.target) ?? `@${step.ref}`;
  return step.action === 'click' ? `click ${target}` : `${step.action} ${target} = "${step.value}"`;
};

const stopReasonOf = (error) => {
  const stopped = { reason: error instanceof Error && error.message ? error.message : 'no step could be chosen' };
  if (trimmedText(error?.code)) stopped.code = error.code;
  if (trimmedText(error?.host)) stopped.host = error.host;
  return stopped;
};

const portOf = (page) => Number(page.port) || (page.protocol === 'https:' ? 443 : 80);

const siteMoved = (label, host = null) => {
  const extra = { code: 'site_moved' };
  if (host) extra.host = host;
  return new MittrToolError(
    `The page moved to ${label}, which the user has not allowed; nothing from it is returned. Call chrome.open with that page's URL to ask the user`,
    409,
    extra,
  );
};

const lookupAll = (host) => dns.promises.lookup(host, { all: true });

const withinTimeout = (work, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timed out')), ms);
  work.then(
    (value) => {
      clearTimeout(timer);
      resolve(value);
    },
    (error) => {
      clearTimeout(timer);
      reject(error);
    },
  );
});

export function createChromeService({
  control,
  settings,
  approvals = NO_APPROVALS,
  writeScreenshot,
  ownPorts = () => [],
  lookup = lookupAll,
  ready = Promise.resolve(),
  scratchRoot = os.tmpdir(),
  stepper = null,
}) {
  const conversationGrants = new Set();
  const modes = new Map();
  let generation = 0;
  let closing = null;

  const isHostAllowed = async (sessionId, host, surface) => (surface === 'voice' && conversationGrants.has(sessionId)) || Boolean(await approvals.isApproved(sessionId, host));

  const isOwnAddress = async (page) => {
    if (!ownPorts().includes(portOf(page))) return false;
    const host = normalizedHost(page.hostname);
    if (isLoopbackOrUnspecified(host)) return true;
    if (net.isIP(host)) return false;
    try {
      const addresses = await withinTimeout(Promise.resolve().then(() => lookup(host)), OWN_LOOKUP_TIMEOUT_MS);
      return !Array.isArray(addresses) || addresses.length === 0 || addresses.some((entry) => isLoopbackOrUnspecified(String(entry?.address ?? '')));
    } catch {
      return true;
    }
  };

  const refuseOwnAddress = async (page) => {
    if (await isOwnAddress(page)) throw new MittrToolError(OWN_ADDRESS, 400);
  };

  const ensureApproved = async (sessionId, host, ctx) => {
    if (await isHostAllowed(sessionId, host, ctx.surface)) return;
    if (ctx.surface === 'voice') throw notYetAllowed(host);
    const reply = await approvals.ask({ sessionId, host, directory: trimmedText(ctx.directory), source: ctx.source, signal: ctx.signal });
    if (reply === 'once' || reply === 'always') return;
    if (reply === 'reject') throw new MittrToolError(`The user did not allow using their Chrome sign-in on ${host}`, 403);
    throw notYetAllowed(host);
  };

  const closeQuietly = (options) => control.run(['close'], { ...options, signal: undefined }).catch(() => undefined);

  const drive = async (command, options) => {
    if (options.generation !== generation) throw new MittrToolError(ACCOUNT_CHANGED, 409);
    const result = await control.run(command, options);
    if (options.generation === generation) return result;
    await closeQuietly(options);
    throw new MittrToolError(ACCOUNT_CHANGED, 409);
  };

  const ensureStillApproved = async (sessionId, options, surface) => {
    const landed = trimmedText((await drive(['get', 'url'], options))?.url);
    if (landed === NO_PAGE) return;
    if (!landed) throw siteMoved('an address the driver did not report');
    let page = null;
    try {
      page = new URL(landed);
    } catch {
      page = null;
    }
    if (!page) throw siteMoved('an address that is not a URL');
    if (page.protocol !== 'http:' && page.protocol !== 'https:') throw siteMoved(`a ${page.protocol} page`, page.protocol);
    await refuseOwnAddress(page);
    const host = page.hostname.toLowerCase();
    if (await isHostAllowed(sessionId, host, surface)) return;
    throw siteMoved(host, host);
  };

  const commandFor = (action, input, ctx) => {
    if (action === 'chrome.open') {
      return { page: pageOf(required(input.url, 'url')) };
    }
    if (action === 'chrome.screenshot') {
      const directory = trimmedText(ctx.directory);
      if (!directory) throw new MittrToolError(NO_SCREENSHOT_DIRECTORY, 400);
      return { directory };
    }
    if (action === 'chrome.close') return {};
    if (action === 'chrome.do') {
      if (!stepper) throw new MittrToolError(NO_STEPPER, 503);
      const goal = required(input.goal, 'goal');
      if (goal.length > MAX_GOAL_CHARS) throw new MittrToolError(GOAL_TOO_LONG, 400);
      return { task: { goal, limit: taskStepLimit(input.maxSteps), pinned: stepper.begin() } };
    }
    const build = CHROME_COMMANDS[action];
    if (!build) throw new MittrToolError(`Unsupported Chrome action: ${action}`, 400);
    return { command: build(input) };
  };

  const notAProfile = () => new MittrToolError(NOT_A_PROFILE, 409, { code: 'chrome_profile_required' });

  const chosenProfile = async (tools, sessionName) => {
    const stored = trimmedText(tools.chromeProfile);
    if (stored) {
      const name = profileOf(stored);
      if (!name) throw notAProfile();
      if (modes.get(sessionName)?.profile === name) return name;
      const listed = await control.profiles().catch(() => []);
      if (!listed.some((entry) => trimmedText(entry?.directory) === name)) throw notAProfile();
      return name;
    }
    const listed = await control.profiles().catch(() => []);
    const only = listed.length === 1 ? profileOf(listed[0]?.directory) : null;
    if (!only) throw new MittrToolError(PROFILE_REQUIRED, 409, { code: 'chrome_profile_required' });
    await settings.update({ tools: { chromeProfile: only } }).catch(() => undefined);
    return only;
  };

  const reopenIfChanged = async (options) => {
    const launched = modes.get(options.sessionName);
    if (!launched || (launched.headed === options.headed && launched.profile === options.profile)) return;
    modes.delete(options.sessionName);
    await closeQuietly(launched);
  };

  const remember = (options) => modes.set(options.sessionName, { sessionName: options.sessionName, profile: options.profile, headed: options.headed });

  const closeRunning = async (sessionId) => {
    const sessionName = chromeSessionName(sessionId);
    const launched = modes.get(sessionName);
    modes.delete(sessionName);
    if (launched) {
      await closeQuietly(launched);
      return;
    }
    const running = await control.sessions().catch(() => []);
    if (!running.includes(sessionName)) return;
    const { tools } = await settings.read();
    await closeQuietly({ sessionName, profile: profileOf(tools.chromeProfile) ?? DEFAULT_PROFILE, headed: tools.chromeHeaded === true });
  };

  const screenshot = async ({ sessionId, surface, directory, label, currentUrl, runAction, options }) => {
    const scratch = await fsPromises.mkdtemp(path.join(scratchRoot, 'mittrcraft-chrome-'));
    try {
      const file = path.join(scratch, 'page.png');
      await runAction(['screenshot', file]);
      await ensureStillApproved(sessionId, options, surface);
      const image = imageOf({ base64: (await fsPromises.readFile(file)).toString('base64'), mime: 'image/png' });
      if (!image) throw new MittrToolError('The Chrome screenshot is not a PNG image', 502);
      const saved = await saveScreenshot({ control: { writeScreenshot }, directory, base64: image.base64, mime: image.mime, label: trimmedText(label) ?? 'chrome' });
      return {
        path: saved.path,
        hint: screenshotHint(saved.path, image.base64),
        url: currentUrl,
        image: saved.image,
      };
    } finally {
      await fsPromises.rm(scratch, { recursive: true, force: true });
    }
  };

  const landedPage = async (sessionId, options, surface) => {
    if (options.signal?.aborted || !modes.has(options.sessionName)) return null;
    try {
      const landed = trimmedText((await drive(['get', 'url'], options))?.url);
      const page = new URL(landed);
      if (page.protocol !== 'http:' && page.protocol !== 'https:') return null;
      if (await isOwnAddress(page)) return null;
      return (await isHostAllowed(sessionId, page.hostname.toLowerCase(), surface)) ? landed : null;
    } catch {
      return null;
    }
  };

  const doTask = async ({ goal, limit, pinned }, ctx, options) => {
    const steps = [];
    const history = [];
    let values;
    const finish = async (outcome, extra = {}) => ({ outcome, ...extra, steps, url: await landedPage(ctx.sessionId, options, ctx.surface) });
    const cancelled = () => ctx.signal?.aborted === true;
    const chromeStopped = (error) => {
      if (!cancelled() && steps.length === 0 && error instanceof MittrToolError && error.statusCode >= 400 && error.statusCode < 499) throw error;
      return finish('stopped', cancelled() ? { reason: CALL_CANCELLED } : stopReasonOf(error));
    };
    for (let index = 0; index < limit; index += 1) {
      if (cancelled()) return finish('stopped', { reason: CALL_CANCELLED });
      let page;
      try {
        page = await perform('chrome.snapshot', {}, ctx, options.generation);
      } catch (error) {
        return chromeStopped(error);
      }
      let reply;
      try {
        reply = await pinned.nextStep({ goal, snapshot: trimmedText(page?.snapshot) ?? '', history, values }, ctx.signal);
      } catch (error) {
        return finish('stopped', cancelled() ? { reason: CALL_CANCELLED } : stopReasonOf(error));
      }
      if (cancelled()) return finish('stopped', { reason: CALL_CANCELLED });
      if (reply.values) values = reply.values;
      const { step } = reply;
      if (step.action === 'done') return finish('done');
      if (step.action === 'ask') return finish('ask', { question: step.question });
      if (step.action === 'stop') return finish('stopped', { reason: step.reason });
      const line = stepLine(step);
      if (history.length >= 2 && history.slice(-2).every((previous) => previous === line)) {
        return finish('stuck', { reason: `the same step was chosen three times: ${line}` });
      }
      const taken = { step: line, decidedBy: reply.decidedBy, ms: reply.ms };
      try {
        await perform(STEP_ACTIONS[step.action], { ref: step.ref, value: step.value }, ctx, options.generation);
      } catch (error) {
        if (error?.code === 'site_moved') steps.push(taken);
        return chromeStopped(error);
      }
      history.push(line);
      steps.push(taken);
    }
    return finish('step_limit', { reason: `stopped after ${limit} steps` });
  };

  const perform = async (action, input, ctx, started) => {
    const sessionId = trimmedText(ctx.sessionId);
    if (!sessionId) throw new MittrToolError('The Chrome tool needs the calling session', 400);
    const planned = commandFor(action, input, ctx);

    if (action === 'chrome.close') {
      approvals.forgetSession(sessionId);
      await closeRunning(sessionId);
      return { closed: true };
    }
    if (!control.chromeInstalled()) throw new MittrToolError('Google Chrome is not installed on this Mac; ask the user to install it', 503);
    await ready;
    if (started !== generation) throw new MittrToolError(ACCOUNT_CHANGED, 409);
    const sessionName = chromeSessionName(sessionId);
    if (!planned.page && !modes.has(sessionName) && !(await control.sessions().catch(() => [])).includes(sessionName)) {
      throw new MittrToolError(NO_PAGE_OPEN, 400);
    }
    const { tools } = await settings.read();
    const options = {
      sessionName,
      profile: await chosenProfile(tools, sessionName),
      headed: ctx.headed === true || tools.chromeHeaded === true,
      signal: ctx.signal,
      generation: started,
    };
    await reopenIfChanged(options);

    const runAction = async (command) => {
      try {
        const result = await drive(command, options);
        remember(options);
        return result;
      } catch (error) {
        if (ctx.signal?.aborted) await closeQuietly(options);
        throw error;
      }
    };

    if (planned.page) {
      await refuseOwnAddress(planned.page);
      await ensureApproved(sessionId, planned.page.hostname.toLowerCase(), ctx);
      const opened = await runAction(['open', planned.page.href]);
      await ensureStillApproved(sessionId, options, ctx.surface);
      return opened;
    }

    const currentUrl = trimmedText((await drive(['get', 'url'], options))?.url);
    if (!currentUrl || currentUrl === NO_PAGE) throw new MittrToolError(NO_PAGE_OPEN, 400);
    const current = pageOf(currentUrl);
    await refuseOwnAddress(current);
    await ensureApproved(sessionId, current.hostname.toLowerCase(), ctx);

    if (planned.task) return doTask(planned.task, { ...ctx, sessionId }, options);
    if (planned.directory) return screenshot({ sessionId, surface: ctx.surface, directory: planned.directory, label: input.label, currentUrl, runAction, options });

    const result = await runAction(planned.command);
    await ensureStillApproved(sessionId, options, ctx.surface);
    return result;
  };

  const execute = async (action, input = {}, ctx = {}) => {
    while (closing) await closing;
    return perform(action, input, ctx, generation);
  };

  const currentPage = async (sessionId) => {
    const id = trimmedText(sessionId);
    const launched = id ? modes.get(chromeSessionName(id)) : undefined;
    if (!launched) return null;
    const options = { ...launched, generation };
    const url = trimmedText((await drive(['get', 'url'], options))?.url);
    if (!url || url === NO_PAGE) return null;
    const title = trimmedText((await drive(['get', 'title'], options))?.title);
    return { url, title: title ?? null };
  };

  const forgetConversation = (sessionId) => {
    conversationGrants.delete(sessionId);
    approvals.forgetSession(sessionId);
  };

  return {
    execute,
    profiles: async () => (control.available ? control.profiles() : []),
    removeHost: async (host) => {
      const removed = await approvals.removeHost(required(host, 'host').toLowerCase());
      conversationGrants.clear();
      return removed;
    },
    closeSession: async (sessionId) => {
      const id = trimmedText(sessionId);
      if (!id) return;
      forgetConversation(id);
      await closeRunning(id).catch(() => undefined);
    },
    closeAll: ({ signal } = {}) => {
      generation += 1;
      modes.clear();
      const running = Promise.resolve().then(() => control.closeAll({ signal }));
      const settled = running.then(() => undefined, () => undefined);
      closing = settled;
      void settled.then(() => {
        if (closing === settled) closing = null;
      });
      return running;
    },
    forgetEveryGrant: () => {
      conversationGrants.clear();
      approvals.forgetAll();
    },
    allowForConversation: (sessionId) => {
      const id = trimmedText(sessionId);
      if (id) conversationGrants.add(id);
    },
    endConversation: (sessionId) => {
      const id = trimmedText(sessionId);
      if (id) forgetConversation(id);
    },
    isHostAllowed,
    currentPage,
  };
}

export function registerChromeActions(registry, { service, available, doTask = () => false }) {
  registry.defineTool({ name: MITTR_TOOLS.chrome, description: chromeToolDescription(), parameters: chromeToolParameters({ doTask: true }) });
  for (const definition of DEFINITIONS) {
    registry.register({
      ...definition,
      tool: MITTR_TOOLS.chrome,
      available: definition.action === 'chrome.do' ? () => available() && doTask() : available,
      execute: (input, ctx) => service.execute(definition.action, input, ctx),
    });
  }
}
