import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MITTR_TOOLS, MittrToolError } from './registry.js';
import { chromeSessionName } from './chrome-control.js';
import { NO_SCREENSHOT_DIRECTORY, fitsAttachment, imageOf, saveScreenshot } from './screenshots.js';

export const CHROME_TOOL_DESCRIPTION = "Use a Chrome session that starts from the user's own Chrome profile, for sites the user is already signed in to in Chrome (Plane, Jira, internal tools) and for web work that should not take over MittrCraft's browser panel. To look at the app being built, use openchamber_web instead. Use one action per call: chrome.open a page, then either chrome.do with the goal to let MittrCraft work through the page step by step on its own (fastest for filling forms and clicking through flows), or chrome.snapshot to get refs and act on them yourself. If chrome.do stops to ask, ask the user; do not guess. The first time you open a site the user is asked whether you may use their sign-in there. If a page asks you to sign in, stop and tell the user which site — never type a password or fill a sign-in form.";

const CHROME_PARAMETERS = Object.freeze({
  url: { type: 'string', description: 'http(s) URL for chrome.open' },
  ref: { type: 'string', description: 'Element ref from the last chrome.snapshot, such as @e3' },
  value: { type: 'string', description: 'Text for chrome.fill or chrome.type, or the option for chrome.select' },
  key: { type: 'string', description: 'Key for chrome.press, such as Enter or Control+a' },
  text: { type: 'string', description: 'Text to wait for with chrome.wait' },
  selector: { type: 'string', description: 'CSS selector to read only part of the page in chrome.snapshot' },
  label: { type: 'string', description: 'Short name for a chrome.screenshot image' },
});

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
  { action: 'chrome.close', effect: 'change', title: 'Close the Chrome session', description: 'Close this session\'s Chrome; no parameters' },
]);

export const NO_APPROVALS = Object.freeze({
  isApproved: async () => false,
  awaitDecision: async () => null,
  forgetSession: () => {},
  forgetAll: () => {},
  removeHost: async () => [],
});

const NO_PAGE = 'about:blank';
const DEFAULT_PROFILE = 'Default';
const OWN_ADDRESS = 'That address is MittrCraft itself';
const PROFILE_REQUIRED = 'No Chrome profile is chosen yet; ask the user to choose one in Settings → Integrations → MittrCraft tools → Chrome profile';

const textOf = (value) => (value === String(value) && value.trim() ? value.trim() : null);

const required = (value, name) => {
  const text = textOf(value);
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
  const match = /^@?(e\d+)$/.exec(textOf(value) ?? '');
  if (!match) throw new MittrToolError('ref must be an element ref from chrome.snapshot, such as @e3', 400);
  return `@${match[1]}`;
};

const keyOf = (value) => {
  const key = textOf(value) ?? '';
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
  'chrome.snapshot': (input) => (textOf(input.selector) ? ['snapshot', '-i', '-s', plainArg(input.selector, 'selector')] : ['snapshot', '-i']),
  'chrome.read': () => ['read'],
  'chrome.click': (input) => ['click', refOf(input.ref)],
  'chrome.fill': (input) => ['fill', refOf(input.ref), plainArg(input.value, 'value', { allowEmpty: true })],
  'chrome.type': (input) => ['type', refOf(input.ref), plainArg(input.value, 'value', { allowEmpty: true })],
  'chrome.press': (input) => ['press', keyOf(input.key)],
  'chrome.select': (input) => ['select', refOf(input.ref), plainArg(input.value, 'value')],
  'chrome.wait': (input) => (textOf(input.text) ? ['wait', '--text', plainArg(input.text, 'text')] : ['wait', refOf(input.ref)]),
};

const LOOPBACK_NAMES = new Set(['localhost', '[::1]', '0.0.0.0', '[::]', '[::ffff:7f00:1]']);

const isLoopbackName = (hostname) => LOOPBACK_NAMES.has(hostname) || hostname.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(hostname);

const portOf = (page) => Number(page.port) || (page.protocol === 'https:' ? 443 : 80);

const siteMoved = (host) => new MittrToolError(
  `The page moved to ${host}, which the user has not allowed; nothing from it is returned. Call chrome.open with that page's URL to ask the user`,
  409,
  { code: 'site_moved', host },
);

export function createChromeService({ control, settings, approvals = NO_APPROVALS, writeScreenshot, ownPorts = () => [], scratchRoot = os.tmpdir() }) {
  const conversationGrants = new Set();
  const modes = new Map();

  const isHostAllowed = async (sessionId, host) => conversationGrants.has(sessionId) || Boolean(await approvals.isApproved(sessionId, host));

  const isOwnAddress = (page) => isLoopbackName(page.hostname.toLowerCase()) && ownPorts().includes(portOf(page));

  const refuseOwnAddress = (page) => {
    if (isOwnAddress(page)) throw new MittrToolError(OWN_ADDRESS, 400);
  };

  const ensureApproved = async (sessionId, host, ctx) => {
    if (await isHostAllowed(sessionId, host)) return;
    if (ctx.approvalAnswered === true) {
      const reply = await approvals.awaitDecision(sessionId, host, ctx.signal);
      if (reply === 'once' || reply === 'always') return;
      if (reply === 'reject') throw new MittrToolError(`The user did not allow using their Chrome sign-in on ${host}`, 403);
    }
    throw new MittrToolError(`The user has not yet allowed using their Chrome sign-in on ${host}`, 403, { code: 'site_approval_required', host });
  };

  const ensureStillApproved = async (sessionId, options) => {
    const landed = textOf((await control.run(['get', 'url'], options))?.url);
    if (!landed || landed === NO_PAGE) return;
    let page = null;
    try {
      page = new URL(landed);
    } catch {
      page = null;
    }
    const web = page?.protocol === 'http:' || page?.protocol === 'https:';
    if (web) refuseOwnAddress(page);
    const host = page?.hostname.toLowerCase() || landed;
    if (web && await isHostAllowed(sessionId, host)) return;
    throw siteMoved(host);
  };

  const commandFor = (action, input, ctx) => {
    if (action === 'chrome.open') {
      const url = required(input.url, 'url');
      return { url, page: pageOf(url) };
    }
    if (action === 'chrome.screenshot') {
      const directory = textOf(ctx.directory);
      if (!directory) throw new MittrToolError(NO_SCREENSHOT_DIRECTORY, 400);
      return { directory };
    }
    if (action === 'chrome.close') return {};
    const build = CHROME_COMMANDS[action];
    if (!build) throw new MittrToolError(`Unsupported Chrome action: ${action}`, 400);
    return { command: build(input) };
  };

  const chosenProfile = async (tools) => {
    const stored = textOf(tools.chromeProfile);
    if (stored) return stored;
    const listed = await control.profiles().catch(() => []);
    const only = listed.length === 1 ? textOf(listed[0]?.directory) : null;
    if (!only) throw new MittrToolError(PROFILE_REQUIRED, 409, { code: 'chrome_profile_required' });
    await settings.update({ tools: { chromeProfile: only } }).catch(() => undefined);
    return only;
  };

  const closeQuietly = (options) => control.run(['close'], { ...options, signal: undefined }).catch(() => undefined);

  const reopenIfChanged = async (options) => {
    const launched = modes.get(options.sessionName);
    if (launched && (launched.headed !== options.headed || launched.profile !== options.profile)) await closeQuietly(launched);
    modes.set(options.sessionName, { sessionName: options.sessionName, profile: options.profile, headed: options.headed });
  };

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
    await closeQuietly({ sessionName, profile: textOf(tools.chromeProfile) ?? DEFAULT_PROFILE, headed: tools.chromeHeaded === true });
  };

  const screenshot = async ({ sessionId, directory, label, currentUrl, runAction, options }) => {
    const scratch = await fsPromises.mkdtemp(path.join(scratchRoot, 'mittrcraft-chrome-'));
    try {
      const file = path.join(scratch, 'page.png');
      await runAction(['screenshot', file]);
      await ensureStillApproved(sessionId, options);
      const image = imageOf({ base64: (await fsPromises.readFile(file)).toString('base64'), mime: 'image/png' });
      if (!image) throw new MittrToolError('The Chrome screenshot is not a PNG image', 502);
      const saved = await saveScreenshot({ control: { writeScreenshot }, directory, base64: image.base64, mime: image.mime, label: textOf(label) ?? 'chrome' });
      return {
        path: saved.path,
        hint: fitsAttachment(image.base64)
          ? `The image is attached for you to view directly; write ![](${saved.path}) in your reply to also show it to the user.`
          : `Write ![](${saved.path}) in your reply to show it to the user.`,
        url: currentUrl,
        image: saved.image,
      };
    } finally {
      await fsPromises.rm(scratch, { recursive: true, force: true });
    }
  };

  const execute = async (action, input = {}, ctx = {}) => {
    const sessionId = textOf(ctx.sessionId);
    if (!sessionId) throw new MittrToolError('The Chrome tool needs the calling session', 400);
    const planned = commandFor(action, input, ctx);

    if (action === 'chrome.close') {
      approvals.forgetSession(sessionId);
      await closeRunning(sessionId);
      return { closed: true };
    }
    if (!control.chromeInstalled()) throw new MittrToolError('Google Chrome is not installed on this Mac; ask the user to install it', 503);
    const { tools } = await settings.read();
    const options = {
      sessionName: chromeSessionName(sessionId),
      profile: await chosenProfile(tools),
      headed: ctx.headed === true || tools.chromeHeaded === true,
      signal: ctx.signal,
    };
    await reopenIfChanged(options);

    const runAction = async (command) => {
      try {
        return await control.run(command, options);
      } catch (error) {
        if (ctx.signal?.aborted) await closeQuietly(options);
        throw error;
      }
    };

    if (planned.page) {
      refuseOwnAddress(planned.page);
      await ensureApproved(sessionId, planned.page.hostname.toLowerCase(), ctx);
      const opened = await runAction(['open', planned.url]);
      await ensureStillApproved(sessionId, options);
      return opened;
    }

    const currentUrl = textOf((await control.run(['get', 'url'], options))?.url);
    if (!currentUrl || currentUrl === NO_PAGE) throw new MittrToolError('No page is open in this session; call chrome.open first', 400);
    const current = pageOf(currentUrl);
    refuseOwnAddress(current);
    await ensureApproved(sessionId, current.hostname.toLowerCase(), ctx);

    if (planned.directory) return screenshot({ sessionId, directory: planned.directory, label: input.label, currentUrl, runAction, options });

    const result = await runAction(planned.command);
    await ensureStillApproved(sessionId, options);
    return result;
  };

  const forgetConversation = (sessionId) => {
    conversationGrants.delete(sessionId);
    approvals.forgetSession(sessionId);
  };

  return {
    execute,
    profiles: async () => (control.available ? control.profiles() : []),
    removeHost: async (host) => approvals.removeHost(required(host, 'host').toLowerCase()),
    closeSession: async (sessionId) => {
      const id = textOf(sessionId);
      if (!id) return;
      forgetConversation(id);
      await closeRunning(id).catch(() => undefined);
    },
    closeAll: async ({ signal } = {}) => {
      modes.clear();
      await control.closeAll({ signal });
    },
    forgetEveryGrant: () => {
      conversationGrants.clear();
      approvals.forgetAll();
    },
    allowForConversation: (sessionId) => {
      const id = textOf(sessionId);
      if (id) conversationGrants.add(id);
    },
    endConversation: (sessionId) => {
      const id = textOf(sessionId);
      if (id) forgetConversation(id);
    },
    isHostAllowed,
  };
}

export function registerChromeActions(registry, { service, available }) {
  registry.defineTool({ name: MITTR_TOOLS.chrome, description: CHROME_TOOL_DESCRIPTION, parameters: CHROME_PARAMETERS });
  for (const definition of DEFINITIONS) {
    registry.register({
      ...definition,
      tool: MITTR_TOOLS.chrome,
      available,
      execute: (input, ctx) => service.execute(definition.action, input, ctx),
    });
  }
}
