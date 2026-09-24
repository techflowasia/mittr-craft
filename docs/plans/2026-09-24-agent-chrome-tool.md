# Agent Chrome Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give MittrCraft agents a `mittrcraft_chrome` tool that drives Google Chrome through the bundled agent-browser CLI, starting from a copy of the user's chosen Chrome profile, asking the user once per site before using that sign-in.

**Architecture:** A new server module `chrome-control.js` runs the vendored `agent-browser` binary with a fixed argv per action and always adds `--session`, `--profile`, `--json`. The control service gates every action on the page's host against a persisted approved-host list; an unapproved host returns `site_approval_required`, which the generated OpenCode plugin turns into `context.ask(...)` and retries with `approveHost`. Settings carry the on/off switch, chosen profile, headed flag and approved hosts.

**Tech Stack:** Node (ESM) server under `packages/web/server`, vitest, React + zustand UI under `packages/ui`, Electron packaging under `packages/electron`, bun as the package manager, agent-browser 0.38.1.

**Spec:** `docs/specs/2026-09-24-agent-chrome-tool.md`

## Global Constraints

- agent-browser version pinned: `0.38.1`; release asset `agent-browser-darwin-arm64` / `agent-browser-darwin-x64` from `https://github.com/vercel-labs/agent-browser/releases/download/v0.38.1/`.
- macOS only in this version; other platforms skip bundling (as `prepare-cua-driver.mjs` does).
- Chrome executable: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, passed as `AGENT_BROWSER_EXECUTABLE_PATH`. Never download a browser.
- Every agent-browser invocation for a page action carries `--session <name> --profile <dir> --json`. A command without `--profile` starts a fresh browser with no sign-in.
- agent-browser exits 0 on failure; success is `parsed.success === true`, the message is `parsed.error`.
- The binary is run with `execFile` (no shell). Only the fixed action table builds argv.
- No `eval`, upload/download, network, `auth`, `chat`, MCP.
- No hardcoded time budgets: cancellation comes from the tool call's abort signal; `wait` uses agent-browser's own timeout.
- Whether a page is a sign-in page is the agent's judgement (tool description), never a server-side word match.
- Repository text in English; no code comments unless the reason is non-obvious; no mention of AI tooling in code, docs or commits.
- Run commands with bun (`bun run --cwd packages/web test -- <file>`).

## Review Focus

1. A URL that is not http(s) (`file:///etc/passwd`, `javascript:`, `chrome://settings`) passed to `chrome.open` must be refused before agent-browser runs — test in Task 3.
2. A page that redirects to another host (SSO to `login.microsoftonline.com`) must stop the next action with an approval request for that host, not act on it silently — test in Task 3.
3. A model that puts `approveHost` inside its own parameters must not approve anything; only the plugin's body field counts — test in Task 4.
4. `chrome.close` for a session that never opened a page (sent by the `session.deleted` hook) must succeed quietly — test in Task 3.
5. A profile directory name with spaces (`Profile 1`) must reach agent-browser as one argv item — test in Task 2.

---

### Task 1: Vendor the agent-browser binary

**Files:**
- Create: `packages/electron/scripts/prepare-agent-browser.mjs`
- Modify: `packages/electron/package.json` (scripts `prepare:agent-browser`, `package`; `build.extraResources`)
- Modify: `.gitignore` only if `packages/electron/resources/cua-driver` is ignored there — add the same line for `resources/agent-browser`

**Interfaces:**
- Produces: `packages/electron/resources/agent-browser/agent-browser` (executable) in dev and `Contents/Resources/agent-browser/agent-browser` in the packaged app.

- [ ] **Step 1: Write the script**

```js
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(__dirname, '..');
const outputDir = path.join(electronRoot, 'resources', 'agent-browser');
const cacheRoot = path.join(electronRoot, '.cache', 'agent-browser');

const AGENT_BROWSER_VERSION = '0.38.1';
const ARCH_ASSETS = { arm64: 'agent-browser-darwin-arm64', x64: 'agent-browser-darwin-x64' };

const readVersion = (binary) => {
  if (!fs.existsSync(binary)) return null;
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) return null;
  return (result.stdout || '').trim().split(/\s+/)[1] || null;
};

const download = async (url, destination) => {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  const temp = `${destination}.tmp`;
  fs.writeFileSync(temp, Buffer.from(await response.arrayBuffer()));
  fs.renameSync(temp, destination);
};

const main = async () => {
  if (process.platform !== 'darwin') {
    console.log(`[electron] skipping agent-browser bundling on ${process.platform} — only darwin is mapped so far`);
    return;
  }
  const asset = ARCH_ASSETS[process.env.MITTRCRAFT_TARGET_ARCH || process.arch];
  if (!asset) throw new Error(`No agent-browser asset for arch ${process.arch}`);

  const output = path.join(outputDir, 'agent-browser');
  if (readVersion(output) === AGENT_BROWSER_VERSION) {
    console.log(`[electron] bundled agent-browser already prepared: ${output} (${AGENT_BROWSER_VERSION})`);
    return;
  }

  const cached = path.join(cacheRoot, AGENT_BROWSER_VERSION, asset);
  if (!fs.existsSync(cached)) {
    const url = `https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}/${asset}`;
    console.log(`[electron] downloading agent-browser ${AGENT_BROWSER_VERSION}: ${asset}`);
    await download(url, cached);
  }

  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.copyFileSync(cached, output);
  fs.chmodSync(output, 0o755);

  const version = readVersion(output);
  if (version !== AGENT_BROWSER_VERSION) {
    throw new Error(`Bundled agent-browser reports ${version ?? 'nothing'}, expected ${AGENT_BROWSER_VERSION}`);
  }
  console.log(`[electron] bundled agent-browser ${version}: ${output}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
```

Check first how `prepare-cua-driver.mjs` chooses the arch for a universal or x64 build (search it for `arch`); if it reads a different variable than `MITTRCRAFT_TARGET_ARCH`, use that one.

- [ ] **Step 2: Wire it into packaging**

In `packages/electron/package.json`:
- add `"prepare:agent-browser": "node ./scripts/prepare-agent-browser.mjs",`
- in `"package"`, insert `&& bun run prepare:agent-browser` right after `bun run prepare:cua-driver`
- in `build.extraResources`, add after the cua-driver entry:

```json
      {
        "from": "resources/agent-browser",
        "to": "agent-browser"
      }
```

- [ ] **Step 3: Run it and verify**

Run: `bun run --cwd packages/electron prepare:agent-browser && packages/electron/resources/agent-browser/agent-browser --version`
Expected: `[electron] bundled agent-browser 0.38.1: …` then `agent-browser 0.38.1`

Run again. Expected: `already prepared` (no download).

Run: `git status --short packages/electron` — the binary must not be tracked. If `resources/agent-browser/` shows as untracked, add it to the same ignore file that ignores `resources/cua-driver`.

- [ ] **Step 4: Commit**

```bash
git add packages/electron/scripts/prepare-agent-browser.mjs packages/electron/package.json .gitignore
git commit -m "build(electron): vendor a pinned agent-browser binary"
```

---

### Task 2: `chrome-control.js` — run agent-browser for one action

**Files:**
- Create: `packages/web/server/lib/mittrcraft-control/chrome-control.js`
- Test: `packages/web/server/lib/mittrcraft-control/chrome-control.test.js`

**Interfaces:**
- Produces:
  - `createChromeControl({ resolve?, chromePath?, exists?, execute? }) → { available: boolean, chromeInstalled(): boolean, run(command: string[], { sessionName, profile, headed, signal }): Promise<object>, profiles(): Promise<Array<{directory: string, name: string}>>, closeAll(): Promise<void> }`
  - `run` resolves with `parsed.data` minus `lifecycle`; rejects with `Error(parsed.error)` when `parsed.success !== true`.
  - `chromeSessionName(sessionId: string) → string` (`mc-` + sessionId with anything outside `[A-Za-z0-9_-]` removed).
  - `CHROME_EXECUTABLE` constant.

- [ ] **Step 1: Write the failing tests**

```js
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { chromeSessionName, createChromeControl } from './chrome-control.js';

const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const fakeBinary = async (reply) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-agent-browser-'));
  temporaryDirectories.push(directory);
  const binary = path.join(directory, 'agent-browser');
  const log = path.join(directory, 'argv.json');
  await fs.writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), chrome: process.env.AGENT_BROWSER_EXECUTABLE_PATH }));
process.stdout.write(${JSON.stringify(JSON.stringify(reply))});
`, { mode: 0o755 });
  return { binary, readCall: async () => JSON.parse(await fs.readFile(log, 'utf8')) };
};

const controlFor = (binary) => createChromeControl({
  resolve: () => binary,
  chromePath: '/fake/Chrome',
  exists: () => true,
});

describe('chromeSessionName', () => {
  it('prefixes and keeps only safe characters', () => {
    expect(chromeSessionName('ses_ab12')).toBe('mc-ses_ab12');
    expect(chromeSessionName('ses/../x y')).toBe('mc-sesxy');
  });
});

describe('createChromeControl.run', () => {
  it('always passes session, profile and json, and the Chrome path', async () => {
    const { binary, readCall } = await fakeBinary({ success: true, data: { url: 'https://example.com/' }, error: null });
    await controlFor(binary).run(['get', 'url'], { sessionName: 'mc-s1', profile: 'Profile 1', headed: false });
    const call = await readCall();
    expect(call.argv.slice(0, 5)).toEqual(['--session', 'mc-s1', '--profile', 'Profile 1', '--json']);
    expect(call.argv.slice(-2)).toEqual(['get', 'url']);
    expect(call.chrome).toBe('/fake/Chrome');
  });

  it('adds --headed only when asked', async () => {
    const { binary, readCall } = await fakeBinary({ success: true, data: {}, error: null });
    await controlFor(binary).run(['read'], { sessionName: 'mc-s1', profile: 'Default', headed: true });
    expect((await readCall()).argv).toContain('--headed');
  });

  it('returns data without the lifecycle block', async () => {
    const { binary } = await fakeBinary({ success: true, data: { url: 'u', lifecycle: { reused: true } }, error: null });
    await expect(controlFor(binary).run(['get', 'url'], { sessionName: 's', profile: 'Default' })).resolves.toEqual({ url: 'u' });
  });

  it('rejects with agent-browser\'s own message when success is false, even on exit 0', async () => {
    const { binary } = await fakeBinary({ success: false, data: null, error: 'Unknown ref: e99' });
    await expect(controlFor(binary).run(['click', '@e99'], { sessionName: 's', profile: 'Default' })).rejects.toThrow('Unknown ref: e99');
  });

  it('keeps a value with spaces and quotes as one argument', async () => {
    const { binary, readCall } = await fakeBinary({ success: true, data: {}, error: null });
    await controlFor(binary).run(['fill', '@e3', 'a "quoted" value; rm -rf /'], { sessionName: 's', profile: 'Default' });
    expect((await readCall()).argv.slice(-3)).toEqual(['fill', '@e3', 'a "quoted" value; rm -rf /']);
  });
});

describe('createChromeControl availability', () => {
  it('is unavailable when no binary resolves', () => {
    expect(createChromeControl({ resolve: () => null }).available).toBe(false);
  });

  it('reports Chrome as missing when the executable does not exist', () => {
    const control = createChromeControl({ resolve: () => '/bin/true', chromePath: '/nope', exists: (p) => p !== '/nope' });
    expect(control.chromeInstalled()).toBe(false);
  });
});

describe('createChromeControl.profiles', () => {
  it('lists profiles without a session or profile flag', async () => {
    const { binary, readCall } = await fakeBinary({ success: true, data: [{ directory: 'Default', name: 'Your Chrome' }] });
    await expect(controlFor(binary).profiles()).resolves.toEqual([{ directory: 'Default', name: 'Your Chrome' }]);
    expect((await readCall()).argv).toEqual(['--json', 'profiles']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run --cwd packages/web test -- server/lib/mittrcraft-control/chrome-control.test.js`
Expected: FAIL — cannot find module `./chrome-control.js`

- [ ] **Step 3: Implement**

```js
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHROME_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BINARY_NAME = 'agent-browser';
const MAX_OUTPUT_CHARS = 12_000;

const devResourcesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../electron/resources',
);

export const bundledAgentBrowserCandidates = () => [
  process.env.MITTRCRAFT_BUNDLED_AGENT_BROWSER_DIR,
  typeof process.resourcesPath === 'string' ? path.join(process.resourcesPath, 'agent-browser') : null,
  path.join(devResourcesDir, 'agent-browser'),
]
  .map((value) => (typeof value === 'string' ? value.trim() : ''))
  .filter(Boolean)
  .map((root) => path.join(root, BINARY_NAME));

const resolveBinary = () => bundledAgentBrowserCandidates().find((candidate) => fs.existsSync(candidate)) || null;

export const chromeSessionName = (sessionId) => `mc-${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '')}`;

const executeBinary = (binary, argv, { env, signal }) => new Promise((resolve, reject) => {
  execFile(binary, argv, { env, signal, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
    if (error && !stdout) {
      reject(error);
      return;
    }
    resolve(stdout);
  });
});

const parseReply = (stdout) => {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`agent-browser did not return JSON: ${String(stdout).slice(0, 200)}`);
  }
  if (parsed?.success !== true) {
    throw new Error(typeof parsed?.error === 'string' && parsed.error ? parsed.error : 'agent-browser command failed');
  }
  return parsed.data;
};

export const createChromeControl = ({
  resolve = resolveBinary,
  chromePath = CHROME_EXECUTABLE,
  exists = fs.existsSync,
  execute = executeBinary,
} = {}) => {
  const binary = resolve();
  const env = { ...process.env, AGENT_BROWSER_EXECUTABLE_PATH: chromePath };

  const call = async (argv, signal) => {
    if (!binary) throw new Error('The Chrome tool is not bundled in this build of MittrCraft');
    return parseReply(await execute(binary, argv, { env, signal }));
  };

  const run = async (command, { sessionName, profile, headed = false, signal } = {}) => {
    const argv = [
      '--session', sessionName,
      '--profile', profile,
      '--json',
      ...(headed ? ['--headed'] : []),
      '--max-output', String(MAX_OUTPUT_CHARS),
      ...command,
    ];
    const data = await call(argv, signal);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const { lifecycle: _lifecycle, ...rest } = data;
      return rest;
    }
    return data;
  };

  const profiles = async () => {
    const data = await call(['--json', 'profiles']);
    return Array.isArray(data) ? data : [];
  };

  const closeAll = async () => {
    if (!binary) return;
    await call(['--json', 'close', '--all']).catch(() => undefined);
  };

  return {
    available: binary !== null,
    chromeInstalled: () => exists(chromePath),
    run,
    profiles,
    closeAll,
  };
};
```

- [ ] **Step 4: Run to verify pass**

Run: `bun run --cwd packages/web test -- server/lib/mittrcraft-control/chrome-control.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/mittrcraft-control/chrome-control.js packages/web/server/lib/mittrcraft-control/chrome-control.test.js
git commit -m "feat(agent-tool): run agent-browser for one Chrome action with the chosen profile"
```

---

### Task 3: Chrome actions in the control service, with the per-site gate

**Files:**
- Modify: `packages/web/server/lib/mittrcraft-control/actions.js` (add chrome definitions, add to `MITTRCRAFT_ALL_ACTIONS`)
- Modify: `packages/web/server/lib/mittrcraft-control/service.js` (dependencies `chromeControl`, `persistSettings`; `chromeAction`; dispatch; `chromeProfiles`)
- Test: `packages/web/server/lib/mittrcraft-control/service.chrome.test.js`

**Interfaces:**
- Consumes: `createChromeControl` shape from Task 2 (`available`, `chromeInstalled()`, `run(command, opts)`, `profiles()`), `chromeSessionName`.
- Produces:
  - `MITTRCRAFT_CHROME_ACTION_DEFINITIONS`, `MITTRCRAFT_CHROME_ACTIONS` exported from `actions.js`.
  - `service.execute(action, input, contextDirectory, { signal, sessionId, approveHost })`.
  - Refusal for an unapproved host: `MittrCraftControlError(message, 403, { code: 'site_approval_required', host })`.
  - `service.chromeProfiles() → Promise<Array<{directory, name}>>`.

- [ ] **Step 1: Add the action definitions**

In `actions.js`, after `MITTRCRAFT_WEB_ACTIONS`:

```js
export const MITTRCRAFT_CHROME_ACTION_DEFINITIONS = Object.freeze([
  { action: 'chrome.open', title: 'Open a page in Chrome', description: 'Open url in a Chrome session that starts from the user\'s chosen Chrome profile, so sites they are signed in to stay signed in. The first use on a site asks the user' },
  { action: 'chrome.snapshot', title: 'Read the Chrome page', description: 'Interactive elements of the open page with refs (@e1) the other chrome actions take; pass selector to read one part' },
  { action: 'chrome.read', title: 'Read the Chrome page as text', description: 'The open page as readable markdown text' },
  { action: 'chrome.click', title: 'Click in Chrome', description: 'Click the element with ref from the last snapshot' },
  { action: 'chrome.fill', title: 'Fill a field in Chrome', description: 'Clear the field with ref and fill it with value' },
  { action: 'chrome.type', title: 'Type in Chrome', description: 'Type value into the field with ref without clearing it' },
  { action: 'chrome.press', title: 'Press a key in Chrome', description: 'Press key, such as Enter, Tab or Control+a' },
  { action: 'chrome.select', title: 'Choose an option in Chrome', description: 'Choose value in the dropdown with ref, by value or visible label' },
  { action: 'chrome.wait', title: 'Wait in Chrome', description: 'Wait until text appears on the page, or until the element with ref appears' },
  { action: 'chrome.screenshot', title: 'Screenshot the Chrome page', description: 'Save the visible page as an image in the project and see it directly; pass label to name it' },
  { action: 'chrome.close', title: 'Close the Chrome session', description: 'Close this session\'s Chrome; no parameters' },
]);

export const MITTRCRAFT_CHROME_ACTIONS = Object.freeze(
  MITTRCRAFT_CHROME_ACTION_DEFINITIONS.map(({ action }) => action),
);
```

And add `...MITTRCRAFT_CHROME_ACTIONS,` to `MITTRCRAFT_ALL_ACTIONS`.

- [ ] **Step 2: Write the failing tests**

`service.chrome.test.js`:

```js
import { describe, expect, it, vi } from 'vitest';

import { createMittrCraftControlService } from './service.js';

const createService = ({ settings = {}, pageUrl = 'https://plane.techflow.asia/', runImpl } = {}) => {
  let stored = { agentChromeProfile: 'Default', agentChromeApprovedHosts: ['plane.techflow.asia'], ...settings };
  const run = vi.fn(runImpl ?? (async (command) => {
    if (command[0] === 'get' && command[1] === 'url') return { url: pageUrl };
    if (command[0] === 'open') return { url: command[1], title: 'Page' };
    if (command[0] === 'snapshot') return { origin: pageUrl, snapshot: '- link "Home" [ref=e1]', refs: { e1: {} } };
    return {};
  }));
  const chromeControl = { available: true, chromeInstalled: () => true, run, profiles: vi.fn(async () => [{ directory: 'Default', name: 'Your Chrome' }]) };
  const persistSettings = vi.fn(async (changes) => { stored = { ...stored, ...changes }; });
  const service = createMittrCraftControlService({
    readSettingsFromDiskMigrated: vi.fn(async () => stored),
    sanitizeProjects: (projects) => projects,
    buildOpenCodeUrl: () => 'http://127.0.0.1:4096/',
    getOpenCodeAuthHeaders: () => ({}),
    waitForOpenCodeReady: vi.fn(),
    sessionService: {},
    scheduledTaskService: {},
    chromeControl,
    persistSettings,
  });
  return { service, run, persistSettings, chromeControl };
};

const opts = { sessionId: 'ses_1' };

describe('chrome actions', () => {
  it('opens an approved host with the chosen profile and this session', async () => {
    const { service, run } = await createService();
    await expect(service.execute('chrome.open', { url: 'https://plane.techflow.asia/x' }, '/repo', opts))
      .resolves.toMatchObject({ url: 'https://plane.techflow.asia/x' });
    expect(run).toHaveBeenCalledWith(['open', 'https://plane.techflow.asia/x'], expect.objectContaining({ sessionName: 'mc-ses_1', profile: 'Default' }));
  });

  it('asks for approval on a host that is not on the list', async () => {
    const { service, run } = await createService();
    await expect(service.execute('chrome.open', { url: 'https://github.com/' }, '/repo', opts))
      .rejects.toMatchObject({ code: 'site_approval_required', host: 'github.com', statusCode: 403 });
    expect(run).not.toHaveBeenCalled();
  });

  it('records the host and proceeds when the plugin passes approveHost for it', async () => {
    const { service, persistSettings } = await createService();
    await service.execute('chrome.open', { url: 'https://github.com/' }, '/repo', { ...opts, approveHost: 'github.com' });
    expect(persistSettings).toHaveBeenCalledWith({ agentChromeApprovedHosts: ['plane.techflow.asia', 'github.com'] });
  });

  it('does not treat approveHost for one host as approval of another', async () => {
    const { service } = await createService();
    await expect(service.execute('chrome.open', { url: 'https://evil.example/' }, '/repo', { ...opts, approveHost: 'github.com' }))
      .rejects.toMatchObject({ code: 'site_approval_required', host: 'evil.example' });
  });

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'not a url'])('refuses %s before running anything', async (url) => {
    const { service, run } = await createService();
    await expect(service.execute('chrome.open', { url }, '/repo', opts)).rejects.toMatchObject({ statusCode: 400 });
    expect(run).not.toHaveBeenCalled();
  });

  it('gates a page action on the host the page is on now, e.g. after an SSO redirect', async () => {
    const { service, run } = await createService({ pageUrl: 'https://login.microsoftonline.com/common/oauth2' });
    await expect(service.execute('chrome.click', { ref: '@e1' }, '/repo', opts))
      .rejects.toMatchObject({ code: 'site_approval_required', host: 'login.microsoftonline.com' });
    expect(run).not.toHaveBeenCalledWith(['click', '@e1'], expect.anything());
  });

  it('asks the agent to open a page first when nothing is open', async () => {
    const { service } = await createService({ pageUrl: 'about:blank' });
    await expect(service.execute('chrome.snapshot', {}, '/repo', opts)).rejects.toThrow(/chrome\.open/);
  });

  it('refuses until a profile is chosen', async () => {
    const { service } = await createService({ settings: { agentChromeProfile: '' } });
    await expect(service.execute('chrome.open', { url: 'https://plane.techflow.asia/' }, '/repo', opts))
      .rejects.toThrow(/choose a Chrome profile/i);
  });

  it('needs the calling session', async () => {
    const { service } = await createService();
    await expect(service.execute('chrome.read', {}, '/repo', {})).rejects.toMatchObject({ statusCode: 400 });
  });

  it('closes quietly even when the session never opened a page', async () => {
    const { service } = await createService({ runImpl: async () => { throw new Error('No session'); } });
    await expect(service.execute('chrome.close', {}, '/repo', opts)).resolves.toEqual({ closed: true });
  });

  it('says Chrome is missing when it is not installed', async () => {
    const { service, chromeControl } = await createService();
    chromeControl.chromeInstalled = () => false;
    await expect(service.execute('chrome.open', { url: 'https://plane.techflow.asia/' }, '/repo', opts))
      .rejects.toThrow(/Google Chrome is not installed/);
  });

  it('maps each page action to its fixed command', async () => {
    const { service, run } = await createService();
    await service.execute('chrome.fill', { ref: '@e3', value: 'hello' }, '/repo', opts);
    await service.execute('chrome.press', { key: 'Enter' }, '/repo', opts);
    await service.execute('chrome.select', { ref: '@e4', value: 'High' }, '/repo', opts);
    await service.execute('chrome.wait', { text: 'Saved' }, '/repo', opts);
    await service.execute('chrome.snapshot', { selector: 'main' }, '/repo', opts);
    const commands = run.mock.calls.map(([command]) => command).filter((command) => command[0] !== 'get');
    expect(commands).toEqual([
      ['fill', '@e3', 'hello'],
      ['press', 'Enter'],
      ['select', '@e4', 'High'],
      ['wait', '--text', 'Saved'],
      ['snapshot', '-i', '-s', 'main'],
    ]);
  });

  it('closes the session when the call is cancelled mid-action', async () => {
    const controller = new AbortController();
    const { service, run } = await createService({
      runImpl: async (command) => {
        if (command[0] === 'get') return { url: 'https://plane.techflow.asia/' };
        if (command[0] === 'read') { controller.abort(); throw new Error('aborted'); }
        return {};
      },
    });
    await expect(service.execute('chrome.read', {}, '/repo', { ...opts, signal: controller.signal })).rejects.toThrow('aborted');
    expect(run).toHaveBeenLastCalledWith(['close'], expect.objectContaining({ sessionName: 'mc-ses_1', signal: undefined }));
  });

  it('lists Chrome profiles for settings', async () => {
    const { service } = await createService();
    await expect(service.chromeProfiles()).resolves.toEqual([{ directory: 'Default', name: 'Your Chrome' }]);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `bun run --cwd packages/web test -- server/lib/mittrcraft-control/service.chrome.test.js`
Expected: FAIL — `Unsupported MittrCraft action: chrome.open` or missing `chromeProfiles`.

- [ ] **Step 4: Implement in `service.js`**

Imports at the top:

```js
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';
import { chromeSessionName } from './chrome-control.js';
```

(If `fs`, `os` or `path` are already imported under other names in `service.js`, reuse those instead.)

Add to the destructured dependencies of `createMittrCraftControlService`:

```js
    chromeControl = null,
    persistSettings = async () => {},
```

Add inside the factory, before `execute`:

```js
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
    'chrome.open': (input) => ['open', asNonEmptyString(input.url)],
    'chrome.snapshot': (input) => (asNonEmptyString(input.selector) ? ['snapshot', '-i', '-s', asNonEmptyString(input.selector)] : ['snapshot', '-i']),
    'chrome.read': () => ['read'],
    'chrome.click': (input) => ['click', required(input.ref, 'ref')],
    'chrome.fill': (input) => ['fill', required(input.ref, 'ref'), String(input.value ?? '')],
    'chrome.type': (input) => ['type', required(input.ref, 'ref'), String(input.value ?? '')],
    'chrome.press': (input) => ['press', required(input.key, 'key')],
    'chrome.select': (input) => ['select', required(input.ref, 'ref'), required(input.value, 'value')],
    'chrome.wait': (input) => (asNonEmptyString(input.text) ? ['wait', '--text', asNonEmptyString(input.text)] : ['wait', required(input.ref, 'ref')]),
  };

  function required(value, name) {
    const text = asNonEmptyString(value);
    if (!text) throw new MittrCraftControlError(`${name} is required`, 400);
    return text;
  }

  const chromeAction = async (action, input, contextDirectory, options = {}) => {
    const sessionId = asNonEmptyString(options.sessionId);
    if (!sessionId) throw new MittrCraftControlError('The Chrome tool needs the calling session', 400);
    const settings = (await readSettingsFromDiskMigrated()) ?? {};
    const profile = asNonEmptyString(settings.agentChromeProfile);
    const runOptions = { sessionName: chromeSessionName(sessionId), profile: profile ?? 'Default', headed: settings.agentChromeHeaded === true, signal: options.signal };

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
      const scratch = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'mittrcraft-chrome-'));
      try {
        const file = nodePath.join(scratch, 'page.png');
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
```

In `execute`, next to the `computer.` branch:

```js
      if (action.startsWith('chrome.')) {
        if (!chromeControl || chromeControl.available !== true) {
          throw new MittrCraftControlError('The Chrome tool is not bundled in this build of MittrCraft', 503);
        }
        return chromeAction(action, input, contextDirectory, options);
      }
```

Add `chromeProfiles` to the object the factory returns.

- [ ] **Step 5: Run the new and existing service tests**

Run: `bun run --cwd packages/web test -- server/lib/mittrcraft-control/`
Expected: PASS (new file and the existing `service.test.js`, `computer-control.test.js`, `routes.test.js`)

- [ ] **Step 6: Commit**

```bash
git add packages/web/server/lib/mittrcraft-control/actions.js packages/web/server/lib/mittrcraft-control/service.js packages/web/server/lib/mittrcraft-control/service.chrome.test.js
git commit -m "feat(agent-tool): Chrome actions gated on sites the user allowed"
```

---

### Task 4: The `mittrcraft_chrome` tool in the generated plugin

**Files:**
- Modify: `packages/web/server/lib/agent-tool/runtime.js`
- Test: `packages/web/server/lib/agent-tool/runtime.test.js`

**Interfaces:**
- Consumes: `MITTRCRAFT_CHROME_ACTION_DEFINITIONS`, `MITTRCRAFT_CHROME_ACTIONS` (Task 3); service error `{ code: 'site_approval_required', host }`.
- Produces:
  - `prepareManagedOpenCodeEnv({ includeControl, includeWeb, includeComputer, includeChrome })`.
  - Callback body fields `contextSessionId` and (plugin-only) `approveHost`; forwarded to `executeAction(action, input, contextDirectory, { signal?, sessionId?, approveHost? })`.
  - Result `error` carries `code` and `host` when the service error has them.

- [ ] **Step 1: Write the failing tests** (append to `runtime.test.js`, reusing its `createRuntime` helper)

```js
describe('mittrcraft_chrome tool', () => {
  const loadPlugin = async (runtime, dataDir, options) => {
    const prepared = await runtime.prepareManagedOpenCodeEnv(options);
    const pluginPath = path.join(dataDir, 'agent-tool', 'mittrcraft-plugin.js');
    const pluginModule = await import(`${pathToFileURL(pluginPath).href}?chrome=${Date.now()}-${Math.random()}`);
    return { prepared, hooks: await pluginModule.MittrCraftPlugin() };
  };

  const withEnv = async (prepared, fn) => {
    const originalUrl = process.env.MITTRCRAFT_AGENT_TOOL_URL;
    const originalToken = process.env.MITTRCRAFT_AGENT_TOOL_TOKEN;
    const originalFetch = globalThis.fetch;
    process.env.MITTRCRAFT_AGENT_TOOL_URL = prepared.MITTRCRAFT_AGENT_TOOL_URL;
    process.env.MITTRCRAFT_AGENT_TOOL_TOKEN = prepared.MITTRCRAFT_AGENT_TOOL_TOKEN;
    try {
      return await fn();
    } finally {
      globalThis.fetch = originalFetch;
      process.env.MITTRCRAFT_AGENT_TOOL_URL = originalUrl;
      process.env.MITTRCRAFT_AGENT_TOOL_TOKEN = originalToken;
    }
  };

  const context = (ask) => ({ sessionID: 'ses_1', directory: '/work', abort: new AbortController().signal, metadata: () => {}, ask });

  it('is emitted only when enabled, with its own ref and key inputs', async () => {
    const { runtime, dataDir } = await createRuntime();
    const { hooks } = await loadPlugin(runtime, dataDir, { includeChrome: true });
    expect(hooks.tool.mittrcraft_chrome).toBeDefined();
    const { hooks: without } = await loadPlugin(runtime, dataDir, { includeChrome: false });
    expect(without.tool.mittrcraft_chrome).toBeUndefined();
  });

  it('asks the user once for an unapproved host and retries with approveHost', async () => {
    const { runtime, dataDir } = await createRuntime();
    const { prepared, hooks } = await loadPlugin(runtime, dataDir, { includeChrome: true });
    const bodies = [];
    const ask = vi.fn(async () => {});
    await withEnv(prepared, async () => {
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        if (!body.approveHost) {
          return new Response(JSON.stringify({ schemaVersion: 1, ok: false, action: 'chrome.open', error: { message: 'not allowed yet', kind: 'usage', code: 'site_approval_required', host: 'github.com' } }));
        }
        return new Response(JSON.stringify({ schemaVersion: 1, ok: true, action: 'chrome.open', data: { url: 'https://github.com/' } }));
      };
      const result = await hooks.tool.mittrcraft_chrome.execute({ action: 'chrome.open', parameters: { url: 'https://github.com/' } }, context(ask));
      expect(JSON.parse(result.output).ok).toBe(true);
    });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ permission: 'mittrcraft_chrome', patterns: ['github.com'], always: ['github.com'] }));
    expect(bodies.map((body) => body.approveHost ?? null)).toEqual([null, 'github.com']);
    expect(bodies[0].contextSessionId).toBe('ses_1');
  });

  it('reports a refusal and does not retry when the user denies', async () => {
    const { runtime, dataDir } = await createRuntime();
    const { prepared, hooks } = await loadPlugin(runtime, dataDir, { includeChrome: true });
    let calls = 0;
    await withEnv(prepared, async () => {
      globalThis.fetch = async () => {
        calls += 1;
        return new Response(JSON.stringify({ schemaVersion: 1, ok: false, action: 'chrome.open', error: { message: 'x', kind: 'usage', code: 'site_approval_required', host: 'github.com' } }));
      };
      const result = await hooks.tool.mittrcraft_chrome.execute({ action: 'chrome.open', parameters: { url: 'https://github.com/' } }, context(async () => { throw new Error('rejected'); }));
      expect(JSON.parse(result.output).error.message).toMatch(/did not allow.*github\.com/);
    });
    expect(calls).toBe(1);
  });

  it('never lets the model approve a host through its own parameters', async () => {
    const { runtime, executeAction } = await createRuntime();
    await runtime.execute({ input: { action: 'chrome.open', url: 'https://x.example/', approveHost: 'x.example' }, contextDirectory: '/w', contextSessionId: 'ses_1' });
    expect(executeAction).toHaveBeenCalledWith('chrome.open', expect.anything(), '/w', { sessionId: 'ses_1' });
  });

  it('passes the plugin\'s approveHost and session through to the service', async () => {
    const { runtime, executeAction } = await createRuntime();
    await runtime.execute({ input: { action: 'chrome.read' }, contextDirectory: '/w', contextSessionId: 'ses_1', approveHost: 'plane.techflow.asia' });
    expect(executeAction).toHaveBeenCalledWith('chrome.read', { action: 'chrome.read' }, '/w', { sessionId: 'ses_1', approveHost: 'plane.techflow.asia' });
  });

  it('carries the approval code and host in the result error', async () => {
    const error = Object.assign(new Error('nope'), { statusCode: 403, code: 'site_approval_required', host: 'github.com' });
    const { runtime } = await createRuntime({ executeAction: vi.fn(async () => { throw error; }) });
    const result = await runtime.execute({ input: { action: 'chrome.open' }, contextSessionId: 'ses_1' });
    expect(result.error).toMatchObject({ code: 'site_approval_required', host: 'github.com' });
  });

  it('closes the session\'s Chrome when OpenCode deletes the session', async () => {
    const { runtime, dataDir } = await createRuntime();
    const { prepared, hooks } = await loadPlugin(runtime, dataDir, { includeChrome: true });
    const bodies = [];
    await withEnv(prepared, async () => {
      globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response('{}'); };
      await hooks.event({ event: { type: 'session.deleted', properties: { info: { id: 'ses_9' } } } });
    });
    expect(bodies).toEqual([{ input: { action: 'chrome.close' }, contextSessionId: 'ses_9' }]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run --cwd packages/web test -- server/lib/agent-tool/runtime.test.js`
Expected: the new tests FAIL; existing tests still PASS.

- [ ] **Step 3: Implement in `runtime.js`**

1. Imports and allowlist:

```js
  MITTRCRAFT_CHROME_ACTION_DEFINITIONS,
  MITTRCRAFT_CHROME_ACTIONS,
```

Add `...MITTRCRAFT_CHROME_ACTIONS` to `ACTIONS` and `...MITTRCRAFT_CHROME_ACTION_DEFINITIONS` to the titles list.

2. The chrome tool's own inputs (not taken from `ALL_PARAMETER_PROPERTIES`, whose `ref`/`key` mean Plane and Jira):

```js
const CHROME_PARAMETER_PROPERTIES = {
  url: { type: 'string', description: 'http(s) URL for chrome.open' },
  ref: { type: 'string', description: 'Element ref from the last chrome.snapshot, such as @e3' },
  value: { type: 'string', description: 'Text for chrome.fill or chrome.type, or the option for chrome.select' },
  key: { type: 'string', description: 'Key for chrome.press, such as Enter or Control+a' },
  text: { type: 'string', description: 'Text to wait for with chrome.wait' },
  selector: { type: 'string', description: 'CSS selector to read only part of the page in chrome.snapshot' },
  label: { type: 'string', description: 'Short name for a chrome.screenshot image' },
};

const CHROME_TOOL_DESCRIPTION = "Use a Chrome session that starts from the user's own Chrome profile, for sites the user is already signed in to in Chrome (Plane, Jira, internal tools) and for web work that should not take over MittrCraft's browser panel. To look at the app being built, use mittrcraft_web instead. Use one action per call: chrome.open a page, chrome.snapshot to get refs, then act on those refs. The first time you open a site the user is asked whether you may use their sign-in there. If a page asks you to sign in, stop and tell the user which site — never type a password or fill a sign-in form.";
```

3. In `createToolEntry`, accept `siteApproval = false`, replace the single `fetch(...)` in the template by a `post` helper, and insert the approval block right after the first parse. The `try` block becomes:

```js
        const post = (extra) => fetch(endpoint, {
          method: "POST",
          headers: {
            authorization: "Bearer " + token,
            "content-type": "application/json",
          },
          body: JSON.stringify({ input: args, contextDirectory: context.directory, contextSessionId: context.sessionID, ...extra }),
          signal: context.abort,
        })

        try {
          let response = await post({})
          let output = await response.text()
          let result = null
          try { result = JSON.parse(output) } catch {}
${siteApproval ? SITE_APPROVAL_SNIPPET : ''}
          const valid = result?.schemaVersion === ${TOOL_SCHEMA_VERSION} && typeof result?.ok === "boolean" && typeof result?.action === "string"
```

(the rest of the block — metadata, attachment lifting, failure — is unchanged)

with, above `createToolEntry`:

```js
const SITE_APPROVAL_SNIPPET = String.raw`
          const pendingHost = result?.ok === false && result?.error?.code === "site_approval_required" && typeof result?.error?.host === "string" ? result.error.host : null
          if (pendingHost) {
            try {
              await context.ask({ permission: "mittrcraft_chrome", patterns: [pendingHost], always: [pendingHost], metadata: { host: pendingHost } })
            } catch (error) {
              if (context.abort.aborted) throw error
              return failure({ schemaVersion: ${TOOL_SCHEMA_VERSION}, ok: false, action: args.action, error: { message: "The user did not allow using their Chrome sign-in on " + pendingHost, kind: "usage" } })
            }
            response = await post({ approveHost: pendingHost })
            output = await response.text()
            result = null
            try { result = JSON.parse(output) } catch {}
          }
`;
```

4. `createPluginSource({ includeControl, includeWeb, includeComputer, includeChrome })` adds:

```js
  if (includeChrome) {
    entries.push(createToolEntry({
      name: 'mittrcraft_chrome',
      description: CHROME_TOOL_DESCRIPTION,
      actions: MITTRCRAFT_CHROME_ACTIONS,
      definitions: MITTRCRAFT_CHROME_ACTION_DEFINITIONS,
      parameters: CHROME_PARAMETER_PROPERTIES,
      siteApproval: true,
    }));
  }
  const chromeEvents = includeChrome ? String.raw`
  event: async ({ event }) => {
    if (event?.type !== "session.deleted") return
    const id = event.properties?.info?.id
    const endpoint = process.env.MITTRCRAFT_AGENT_TOOL_URL
    const token = process.env.MITTRCRAFT_AGENT_TOOL_TOKEN
    if (!id || !endpoint || !token) return
    await fetch(endpoint, {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ input: { action: "chrome.close" }, contextSessionId: id }),
    }).catch(() => {})
  },
` : '';

  return `export const MittrCraftPlugin = async () => ({
  tool: {
${entries.join('')}  },${chromeEvents}
})
`;
```

5. `prepareManagedOpenCodeEnv({ includeControl = true, includeWeb = true, includeComputer = false, includeChrome = false } = {})`: include `includeChrome` in the "at least one tool" check and pass it to `createPluginSource`.

6. In `execute(payload, options)`:

```js
    const forwarded = {
      ...options,
      ...(asNonEmptyString(payload.contextSessionId) ? { sessionId: asNonEmptyString(payload.contextSessionId) } : {}),
      ...(asNonEmptyString(payload.approveHost) ? { approveHost: asNonEmptyString(payload.approveHost) } : {}),
    };
    const data = await executeAction(action, payload.input, payload.contextDirectory, forwarded);
```

and in the `catch` result's `error` object add:

```js
          ...(typeof error?.code === 'string' ? { code: error.code } : {}),
          ...(typeof error?.host === 'string' ? { host: error.host } : {}),
```

- [ ] **Step 4: Run to verify pass**

Run: `bun run --cwd packages/web test -- server/lib/agent-tool/runtime.test.js`
Expected: PASS, including the pre-existing `delegates %s to the shared control service` tests (they still see `{}` as options).

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/agent-tool/runtime.js packages/web/server/lib/agent-tool/runtime.test.js
git commit -m "feat(agent-tool): mittrcraft_chrome tool that asks the user once per site"
```

---

### Task 5: Server wiring — settings, profiles route, shutdown

**Files:**
- Modify: `packages/web/server/lib/opencode/settings-helpers.js` (`sanitizeSettingsUpdate`)
- Test: `packages/web/server/lib/opencode/settings-helpers.test.js`
- Modify: `packages/web/server/index.js` (create `chromeControl`, pass `chromeControl` + `persistSettings` to the control service, `includeChrome`, shutdown)
- Modify: `packages/web/server/lib/mittrcraft-control/routes.js` (GET profiles)
- Test: `packages/web/server/lib/mittrcraft-control/routes.test.js`
- Modify: `packages/web/server/lib/opencode/shutdown-runtime.js` (optional `closeBrowserSessions`)

**Interfaces:**
- Consumes: `createChromeControl` (Task 2), `service.chromeProfiles()` (Task 3), `prepareManagedOpenCodeEnv({ includeChrome })` (Task 4).
- Produces: persisted settings `agentChromeToolEnabled: boolean`, `agentChromeProfile: string`, `agentChromeApprovedHosts: string[]`, `agentChromeHeaded: boolean`; `GET /api/mittrcraft/chrome/profiles → { profiles: Array<{directory, name}> }`.

- [ ] **Step 1: Write the failing settings test** (append to `settings-helpers.test.js`)

```js
describe('sanitizeSettingsUpdate — agent tools', () => {
  it('keeps the computer and Chrome tool settings', () => {
    const { sanitizeSettingsUpdate } = createTestHelpers();
    expect(sanitizeSettingsUpdate({
      agentComputerToolEnabled: false,
      agentChromeToolEnabled: false,
      agentChromeProfile: 'Profile 1',
      agentChromeHeaded: true,
      agentChromeApprovedHosts: ['Plane.Techflow.Asia', 'plane.techflow.asia', '', 42, 'github.com'],
    })).toMatchObject({
      agentComputerToolEnabled: false,
      agentChromeToolEnabled: false,
      agentChromeProfile: 'Profile 1',
      agentChromeHeaded: true,
      agentChromeApprovedHosts: ['plane.techflow.asia', 'github.com'],
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run --cwd packages/web test -- server/lib/opencode/settings-helpers.test.js`
Expected: FAIL — the fields are dropped (including `agentComputerToolEnabled`, which today never persists on the server).

- [ ] **Step 3: Implement the sanitizer**

In `sanitizeSettingsUpdate`, after the `agentControlToolEnabled` block:

```js
    if (typeof candidate.agentComputerToolEnabled === 'boolean') {
      result.agentComputerToolEnabled = candidate.agentComputerToolEnabled;
    }
    if (typeof candidate.agentChromeToolEnabled === 'boolean') {
      result.agentChromeToolEnabled = candidate.agentChromeToolEnabled;
    }
    if (typeof candidate.agentChromeHeaded === 'boolean') {
      result.agentChromeHeaded = candidate.agentChromeHeaded;
    }
    if (typeof candidate.agentChromeProfile === 'string') {
      result.agentChromeProfile = candidate.agentChromeProfile.trim();
    }
    if (Array.isArray(candidate.agentChromeApprovedHosts)) {
      result.agentChromeApprovedHosts = [...new Set(
        candidate.agentChromeApprovedHosts
          .filter((host) => typeof host === 'string')
          .map((host) => host.trim().toLowerCase())
          .filter(Boolean),
      )];
    }
```

Run the test again. Expected: PASS.

- [ ] **Step 4: Write the failing route test** (append to `routes.test.js`, following its existing setup for `registerMittrCraftControlRoutes`)

```js
it('lists Chrome profiles for the settings screen', async () => {
  const app = express();
  registerMittrCraftControlRoutes(app, { controlService: { execute: vi.fn(), chromeProfiles: vi.fn(async () => [{ directory: 'Default', name: 'Your Chrome' }]) } });
  const response = await request(app).get('/api/mittrcraft/chrome/profiles');
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ profiles: [{ directory: 'Default', name: 'Your Chrome' }] });
});
```

(Use the imports `routes.test.js` already has; add `supertest`/`express`/`vi` only if missing.)

- [ ] **Step 5: Implement the route**

In `routes.js`, inside `registerMittrCraftControlRoutes`:

```js
  app.get('/api/mittrcraft/chrome/profiles', async (_req, res) => {
    try {
      const profiles = typeof controlService.chromeProfiles === 'function' ? await controlService.chromeProfiles() : [];
      return res.json({ profiles });
    } catch (error) {
      const controlError = asControlError(error, 'Could not list Chrome profiles');
      return res.status(controlError.statusCode).json({ error: controlError.message });
    }
  });
```

Run: `bun run --cwd packages/web test -- server/lib/mittrcraft-control/routes.test.js` → PASS.

- [ ] **Step 6: Wire `index.js`**

- import: `import { createChromeControl } from './lib/mittrcraft-control/chrome-control.js';`
- after `const computerControl = createComputerControl();` add `const chromeControl = createChromeControl();`
- in `createMittrCraftControlService({...})` add `chromeControl,` and `persistSettings,`
- in `getManagedOpenCodeEnv`: `const includeChrome = settings?.agentChromeToolEnabled !== false && chromeControl.available;` include it in the `||` condition and pass `includeChrome` to `prepareManagedOpenCodeEnv`.
- in `createGracefulShutdownRuntime({...})` add `closeBrowserSessions: () => chromeControl.closeAll(),`

In `shutdown-runtime.js`, destructure `closeBrowserSessions = null` and, at the start of `runShutdown` after `setIsShuttingDown(true);`:

```js
    if (typeof closeBrowserSessions === 'function') {
      await Promise.resolve(closeBrowserSessions()).catch(() => undefined);
    }
```

- [ ] **Step 7: Run the whole web suite**

Run: `bun run --cwd packages/web test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/web/server/index.js packages/web/server/lib/opencode/settings-helpers.js packages/web/server/lib/opencode/settings-helpers.test.js packages/web/server/lib/mittrcraft-control/routes.js packages/web/server/lib/mittrcraft-control/routes.test.js packages/web/server/lib/opencode/shutdown-runtime.js
git commit -m "feat(agent-tool): wire the Chrome tool into settings, profiles and shutdown

The computer tool switch is now kept by the server too; it was dropped by the
settings sanitizer, so turning it off never reached the engine."
```

---

### Task 6: Settings screen

**Files:**
- Create: `packages/ui/src/lib/chromeProfilesApi.ts`
- Modify: `packages/ui/src/lib/desktop.ts` (settings type)
- Modify: `packages/ui/src/stores/useUIStore.ts` (state, setters, defaults, persisted slice)
- Modify: `packages/ui/src/lib/persistence.ts` (defaults and apply-from-settings)
- Modify: `packages/ui/src/components/sections/mittrcraft/MittrCraftToolsSettings.tsx`
- Modify: `packages/ui/src/lib/i18n/messages/en.settings.ts`

**Interfaces:**
- Consumes: `GET /api/mittrcraft/chrome/profiles` and the four settings from Task 5; `updateDesktopSettings` from `@/lib/persistence`.
- Produces: store fields `agentChromeToolEnabled: boolean` (default `true`), `agentChromeProfile: string` (default `''`), `agentChromeApprovedHosts: string[]` (default `[]`), `agentChromeHeaded: boolean` (default `false`) with setters `setAgentChromeToolEnabled`, `setAgentChromeProfile`, `setAgentChromeApprovedHosts`, `setAgentChromeHeaded`.

- [ ] **Step 1: API helper**

```ts
import { runtimeFetch } from './runtime-fetch';

export type ChromeProfile = { directory: string; name: string };

export const fetchChromeProfiles = async (): Promise<ChromeProfile[]> => {
  const response = await runtimeFetch('/api/mittrcraft/chrome/profiles');
  if (!response.ok) return [];
  const parsed = await response.json().catch(() => null);
  return Array.isArray(parsed?.profiles) ? (parsed.profiles as ChromeProfile[]) : [];
};
```

- [ ] **Step 2: Types, store, persistence** — mirror every place `agentComputerToolEnabled` appears:

- `desktop.ts` settings type: `agentChromeToolEnabled?: boolean; agentChromeProfile?: string; agentChromeApprovedHosts?: string[]; agentChromeHeaded?: boolean;`
- `useUIStore.ts`: state fields (next to line 770), setter signatures (next to line 946), defaults (next to line 1109: `agentChromeToolEnabled: true, agentChromeProfile: '', agentChromeApprovedHosts: [], agentChromeHeaded: false,`), setter implementations (next to line 2341, each a plain `set({...})`), persisted slice (next to line 2728).
- `persistence.ts`: defaults block (next to line 545) and apply block (next to line 723). For the array compare with `JSON.stringify(settings.agentChromeApprovedHosts) !== JSON.stringify(store.agentChromeApprovedHosts)` and guard with `Array.isArray`; for the profile guard with `typeof === 'string'`.

Run: `bun run --cwd packages/ui type-check` → no errors.

- [ ] **Step 3: The settings section**

In `MittrCraftToolsSettings.tsx`, after the computer tool row, add the switch, then (only while it is on) the profile select, headed switch and approved sites:

```tsx
        <SettingsCheckboxRow
          settingsItem="sessions.agent-chrome-tool"
          checked={agentChromeToolEnabled}
          onChange={handleAgentChromeToolChange}
          label={t('settings.mittrcraft.tools.field.agentChromeTool')}
          ariaLabel={t('settings.mittrcraft.tools.field.agentChromeToolAria')}
          info={t('settings.mittrcraft.tools.field.agentChromeToolInfo')}
        />
        {agentChromeToolEnabled && (
          <>
            <SettingsFieldRow settingsItem="sessions.agent-chrome-profile" label={t('settings.mittrcraft.tools.field.agentChromeProfile')}>
              <Select value={agentChromeProfile || undefined} onValueChange={handleChromeProfileChange}>
                <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                  <SelectValue placeholder={t('settings.mittrcraft.tools.field.agentChromeProfilePlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {profiles.map((profile) => (
                    <SelectItem key={profile.directory} value={profile.directory}>{profile.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsFieldRow>
            <SettingsCheckboxRow
              settingsItem="sessions.agent-chrome-headed"
              checked={agentChromeHeaded}
              onChange={handleChromeHeadedChange}
              label={t('settings.mittrcraft.tools.field.agentChromeHeaded')}
              ariaLabel={t('settings.mittrcraft.tools.field.agentChromeHeaded')}
            />
            <SettingsFieldRow settingsItem="sessions.agent-chrome-sites" label={t('settings.mittrcraft.tools.field.agentChromeSites')}>
              {agentChromeApprovedHosts.length === 0 ? (
                <span className={SETTINGS_HELPER_CLASS}>{t('settings.mittrcraft.tools.field.agentChromeSitesEmpty')}</span>
              ) : (
                <ul className="w-full space-y-1">
                  {agentChromeApprovedHosts.map((host) => (
                    <li key={host} className="flex items-center justify-between gap-2">
                      <span className="typography-meta truncate">{host}</span>
                      <Button size="sm" variant="ghost" onClick={() => handleRemoveChromeHost(host)} aria-label={t('settings.mittrcraft.tools.field.agentChromeSiteRemove', { host })}>
                        {t('settings.mittrcraft.tools.field.agentChromeSiteRemoveShort')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </SettingsFieldRow>
          </>
        )}
```

Handlers, in the same style as the existing ones:

```tsx
  const [profiles, setProfiles] = React.useState<ChromeProfile[]>([]);
  React.useEffect(() => {
    if (!agentChromeToolEnabled) return;
    let cancelled = false;
    void fetchChromeProfiles().then((list) => { if (!cancelled) setProfiles(list); });
    return () => { cancelled = true; };
  }, [agentChromeToolEnabled]);

  const handleAgentChromeToolChange = React.useCallback((enabled: boolean) => {
    setAgentChromeToolEnabled(enabled);
    void updateDesktopSettings({ agentChromeToolEnabled: enabled });
    recordDeferredOpenCodeRestart('cli', { id: 'agent-chrome-tool' });
  }, [setAgentChromeToolEnabled]);

  const handleChromeProfileChange = React.useCallback((directory: string) => {
    setAgentChromeProfile(directory);
    void updateDesktopSettings({ agentChromeProfile: directory });
  }, [setAgentChromeProfile]);

  const handleChromeHeadedChange = React.useCallback((headed: boolean) => {
    setAgentChromeHeaded(headed);
    void updateDesktopSettings({ agentChromeHeaded: headed });
  }, [setAgentChromeHeaded]);

  const handleRemoveChromeHost = React.useCallback((host: string) => {
    const next = agentChromeApprovedHosts.filter((entry) => entry !== host);
    setAgentChromeApprovedHosts(next);
    void updateDesktopSettings({ agentChromeApprovedHosts: next });
  }, [agentChromeApprovedHosts, setAgentChromeApprovedHosts]);
```

Imports to add: `SettingsFieldRow`, `SETTINGS_HELPER_CLASS`, `SETTINGS_SELECT_ROW_TRIGGER_CLASS`, `SETTINGS_SELECT_SIZE` from the shared section; `Select, SelectContent, SelectItem, SelectTrigger, SelectValue` from `@/components/ui/select`; `Button` from `@/components/ui/button` (check the path other settings files use); `fetchChromeProfiles, type ChromeProfile` from `@/lib/chromeProfilesApi`.

Profile and headed changes need no engine restart (read per call); only the tool switch records one.

- [ ] **Step 4: Strings** (in `en.settings.ts`, next to the computer tool keys; other locales fall back to English)

```ts
  'settings.mittrcraft.tools.field.agentChromeTool': 'Agent Chrome sessions',
  'settings.mittrcraft.tools.field.agentChromeToolAria': 'Enable agent Chrome sessions',
  'settings.mittrcraft.tools.field.agentChromeToolInfo': 'Let agents use Chrome starting from a copy of the Chrome profile you choose, so sites you are signed in to stay signed in. You are asked the first time an agent uses each site. Applies after MittrCraft Engine restarts.',
  'settings.mittrcraft.tools.field.agentChromeProfile': 'Chrome profile',
  'settings.mittrcraft.tools.field.agentChromeProfilePlaceholder': 'Choose a profile',
  'settings.mittrcraft.tools.field.agentChromeHeaded': 'Show the Chrome window while agents use it',
  'settings.mittrcraft.tools.field.agentChromeSites': 'Allowed sites',
  'settings.mittrcraft.tools.field.agentChromeSitesEmpty': 'No sites yet — you will be asked the first time.',
  'settings.mittrcraft.tools.field.agentChromeSiteRemove': 'Remove {host}',
  'settings.mittrcraft.tools.field.agentChromeSiteRemoveShort': 'Remove',
```

Check how an existing key interpolates a variable (search `en.settings.ts` for `{` inside a value) and use the same placeholder syntax for `{host}`.

- [ ] **Step 5: Verify**

Run: `bun run --cwd packages/ui type-check && bun run --cwd packages/ui lint && bun run --cwd packages/ui test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src
git commit -m "feat(settings): choose the Chrome profile and review allowed sites for agent Chrome sessions"
```

---

### Task 7: Walk it for real and package

This task borrows the owner's Chrome profile. **Ask the owner and wait for a yes before Step 2.**

- [ ] **Step 1: Full checks**

Run: `bun run --cwd packages/web test && bun run --cwd packages/ui type-check && bun run --cwd packages/ui test`
Expected: all pass.

- [ ] **Step 2: Dev walk** (after the owner's yes)

Start `MITTRCRAFT_BROKER_URL=https://api.mittr.asia bun run electron:dev` (or the local broker the owner names). In the app:
1. Settings → MittrCraft tools: Agent Chrome sessions on, choose the profile the owner names, restart the engine when asked.
2. New session, ask: "open https://workspace.mittr.asia/engine/agents in Chrome and list the agents". Expect the permission prompt naming `workspace.mittr.asia`. Allow.
3. Expect the agent to call `chrome.open`, `chrome.snapshot`/`chrome.read`, and answer with the agent list. Settings → Allowed sites shows `workspace.mittr.asia`.
4. Ask again in the same session: no prompt.
5. Ask it to open `https://github.com/`: prompt appears; deny; the agent says it was not allowed.
6. Ask it to open a site the profile is not signed in to; the agent reports a sign-in page and does not fill it.
7. Delete the session; `pgrep -fl agent-browser` shows no daemon for `mc-<that session>`.
8. Remove `workspace.mittr.asia` in Settings; next open asks again.

- [ ] **Step 3: Verify `--allowed-domains` with `--profile`** (same approval)

Run once by hand: `packages/electron/resources/agent-browser/agent-browser --session probe --profile Default --allowed-domains workspace.mittr.asia --json open https://workspace.mittr.asia` with `AGENT_BROWSER_EXECUTABLE_PATH` set, then `close`. If it succeeds, open a follow-up change passing the approved hosts as `--allowed-domains` too; if it refuses, record that in the spec §6.

- [ ] **Step 4: Package**

Run: `bun run electron:build`
Expected: `packages/electron/dist/mac-arm64/MittrCraft.app/Contents/Resources/agent-browser/agent-browser --version` prints `agent-browser 0.38.1`. Install the dmg, repeat Step 2 items 2–3 against the installed app.

- [ ] **Step 5: Commit any fixes from the walk, then report** what was walked, with a screenshot of the prompt and of the agent's answer.
