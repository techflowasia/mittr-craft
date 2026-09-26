import { describe, expect, it, vi } from 'vitest';

import { createMittrCraftControlService } from './service.js';
import { createChromeApprovals } from './chrome-approvals.js';

const createService = ({ settings = {}, pageUrl = 'https://plane.techflow.asia/', runImpl, stepper = null } = {}) => {
  let stored = { agentChromeProfile: 'Default', agentChromeApprovedHosts: ['plane.techflow.asia'], ...settings };
  const page = { url: pageUrl };
  const run = vi.fn(runImpl ?? (async (command) => {
    if (command[0] === 'get' && command[1] === 'url') return { url: page.url };
    if (command[0] === 'open') return { url: command[1], title: 'Page' };
    if (command[0] === 'snapshot') return { origin: pageUrl, snapshot: '- link "Home" [ref=e1]', refs: { e1: {} } };
    return {};
  }));
  const chromeControl = { available: true, chromeInstalled: () => true, run, profiles: vi.fn(async () => [{ directory: 'Default', name: 'Your Chrome' }]) };
  const persistSettings = vi.fn(async (changes) => { stored = { ...stored, ...changes }; });
  const chromeApprovals = createChromeApprovals({ readSettings: async () => stored, persistSettings });
  const service = createMittrCraftControlService({
    readSettingsFromDiskMigrated: vi.fn(async () => stored),
    sanitizeProjects: (projects) => projects,
    buildOpenCodeUrl: () => 'http://127.0.0.1:4096/',
    getOpenCodeAuthHeaders: () => ({}),
    waitForOpenCodeReady: vi.fn(),
    sessionService: {},
    scheduledTaskService: {},
    chromeControl,
    chromeApprovals,
    getBrowserStepper: () => stepper,
  });
  const ask = (host, id = 'per_1') => chromeApprovals.handleEvent({ type: 'permission.asked', properties: { id, sessionID: 'ses_1', permission: 'mittrcraft_chrome', patterns: [host], always: [host], metadata: {} } });
  const answer = (reply, id = 'per_1') => chromeApprovals.handleEvent({ type: 'permission.replied', properties: { requestID: id, sessionID: 'ses_1', reply } });
  return { service, run, persistSettings, chromeControl, ask, answer, page, stored: () => stored };
};

const opts = { sessionId: 'ses_1' };

describe('chrome actions', () => {
  it('opens an approved host with the chosen profile and this session', async () => {
    const { service, run } = createService();
    await expect(service.execute('chrome.open', { url: 'https://plane.techflow.asia/x' }, '/repo', opts))
      .resolves.toMatchObject({ url: 'https://plane.techflow.asia/x' });
    expect(run).toHaveBeenCalledWith(['open', 'https://plane.techflow.asia/x'], expect.objectContaining({ sessionName: 'mc-ses_1', profile: 'Default' }));
  });

  it('asks for approval on a host that is not on the list', async () => {
    const { service, run } = createService();
    await expect(service.execute('chrome.open', { url: 'https://github.com/' }, '/repo', opts))
      .rejects.toMatchObject({ code: 'site_approval_required', host: 'github.com', statusCode: 403 });
    expect(run).not.toHaveBeenCalled();
  });

  it('proceeds once the user\'s answer arrives, even if it arrives after the retry', async () => {
    const { service, ask, answer, page, stored } = createService();
    await ask('github.com');
    page.url = 'https://github.com/';
    const call = service.execute('chrome.open', { url: 'https://github.com/' }, '/repo', { ...opts, approvalAnswered: true });
    await answer('always');
    await expect(call).resolves.toMatchObject({ url: 'https://github.com/' });
    expect(stored().agentChromeApprovedHosts).toEqual(['plane.techflow.asia', 'github.com']);
  });

  it('refuses when the user rejected the site', async () => {
    const { service, ask, answer } = createService();
    await ask('github.com');
    await answer('reject');
    await expect(service.execute('chrome.open', { url: 'https://github.com/' }, '/repo', { ...opts, approvalAnswered: true }))
      .rejects.toThrow(/did not allow.*github\.com/);
  });

  it('never approves on the caller\'s word alone — no question asked means ask again', async () => {
    const { service, run } = createService();
    await expect(service.execute('chrome.open', { url: 'https://evil.example/' }, '/repo', { ...opts, approvalAnswered: true }))
      .rejects.toMatchObject({ code: 'site_approval_required', host: 'evil.example' });
    expect(run).not.toHaveBeenCalled();
  });

  it('withholds the result when an action lands on a host the user has not allowed', async () => {
    const { service, page } = createService({
      runImpl: async (command) => {
        if (command[0] === 'get') return { url: page.url };
        if (command[0] === 'click') { page.url = 'https://evil.example/landing'; return { clicked: '@e1' }; }
        return {};
      },
    });
    await expect(service.execute('chrome.click', { ref: '@e1' }, '/repo', opts))
      .rejects.toMatchObject({ code: 'site_moved', host: 'evil.example', statusCode: 409 });
  });

  it('withholds an opened page that redirected to a host the user has not allowed', async () => {
    const { service, page } = createService({
      runImpl: async (command) => {
        if (command[0] === 'get') return { url: page.url };
        if (command[0] === 'open') { page.url = 'https://login.microsoftonline.com/common'; return { url: command[1], title: 'Sign in' }; }
        return {};
      },
    });
    await expect(service.execute('chrome.open', { url: 'https://plane.techflow.asia/' }, '/repo', opts))
      .rejects.toMatchObject({ code: 'site_moved', host: 'login.microsoftonline.com' });
  });

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'not a url'])('refuses %s before running anything', async (url) => {
    const { service, run } = createService();
    await expect(service.execute('chrome.open', { url }, '/repo', opts)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/http\(s\)/) });
    expect(run).not.toHaveBeenCalled();
  });

  it('gates a page action on the host the page is on now, e.g. after an SSO redirect', async () => {
    const { service, run } = createService({ pageUrl: 'https://login.microsoftonline.com/common/oauth2' });
    await expect(service.execute('chrome.click', { ref: '@e1' }, '/repo', opts))
      .rejects.toMatchObject({ code: 'site_approval_required', host: 'login.microsoftonline.com' });
    expect(run).not.toHaveBeenCalledWith(['click', '@e1'], expect.anything());
  });

  it('asks the agent to open a page first when nothing is open', async () => {
    const { service } = createService({ pageUrl: 'about:blank' });
    await expect(service.execute('chrome.snapshot', {}, '/repo', opts)).rejects.toThrow(/chrome\.open/);
  });

  it('refuses until a profile is chosen', async () => {
    const { service } = createService({ settings: { agentChromeProfile: '' } });
    await expect(service.execute('chrome.open', { url: 'https://plane.techflow.asia/' }, '/repo', opts))
      .rejects.toThrow(/choose a Chrome profile/i);
  });

  it('needs the calling session', async () => {
    const { service } = createService();
    await expect(service.execute('chrome.read', {}, '/repo', {})).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/calling session/) });
  });

  it('closes quietly even when the session never opened a page', async () => {
    const { service } = createService({ runImpl: async () => { throw new Error('No session'); } });
    await expect(service.execute('chrome.close', {}, '/repo', opts)).resolves.toEqual({ closed: true });
  });

  it('says Chrome is missing when it is not installed', async () => {
    const { service, chromeControl } = createService();
    chromeControl.chromeInstalled = () => false;
    await expect(service.execute('chrome.open', { url: 'https://plane.techflow.asia/' }, '/repo', opts))
      .rejects.toThrow(/Google Chrome is not installed/);
  });

  it('maps each page action to its fixed command', async () => {
    const { service, run } = createService();
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
    const { service, run } = createService({
      runImpl: async (command) => {
        if (command[0] === 'get') return { url: 'https://plane.techflow.asia/' };
        if (command[0] === 'read') { controller.abort(); throw new Error('aborted'); }
        return {};
      },
    });
    await expect(service.execute('chrome.read', {}, '/repo', { ...opts, signal: controller.signal })).rejects.toThrow('aborted');
    expect(run).toHaveBeenLastCalledWith(['close'], expect.objectContaining({ sessionName: 'mc-ses_1', signal: undefined }));
  });

  it.each([
    ['chrome.click', { ref: '--session' }],
    ['chrome.click', { ref: 'e1; --profile x' }],
    ['chrome.fill', { ref: '@e3', value: '--profile' }],
    ['chrome.type', { ref: '@e3', value: '-x' }],
    ['chrome.select', { ref: '@e4', value: '--proxy' }],
    ['chrome.press', { key: '--allow-file-access' }],
    ['chrome.wait', { text: '--session' }],
    ['chrome.snapshot', { selector: '--auto-connect' }],
  ])('refuses %s input that agent-browser would read as a flag', async (action, input) => {
    const { service, run } = createService();
    await expect(service.execute(action, input, '/repo', opts)).rejects.toMatchObject({ statusCode: 400 });
    expect(run.mock.calls.map(([command]) => command[0])).not.toContain(action.split('.')[1]);
  });

  it('accepts refs with or without the @ and ordinary key names', async () => {
    const { service, run } = createService();
    await service.execute('chrome.click', { ref: 'e12' }, '/repo', opts);
    await service.execute('chrome.press', { key: 'Control+a' }, '/repo', opts);
    const commands = run.mock.calls.map(([command]) => command).filter((command) => command[0] !== 'get');
    expect(commands).toEqual([['click', '@e12'], ['press', 'Control+a']]);
  });

  it('lists Chrome profiles for settings', async () => {
    const { service } = createService();
    await expect(service.chromeProfiles()).resolves.toEqual([{ directory: 'Default', name: 'Your Chrome' }]);
  });
});

describe('removing an allowed Chrome site', () => {
  it('removes it from the persisted list, lowercased', async () => {
    const { service, stored } = createService({ settings: { agentChromeApprovedHosts: ['plane.techflow.asia', 'github.com'] } });
    await expect(service.removeChromeHost('GitHub.com')).resolves.toEqual(['plane.techflow.asia']);
    expect(stored().agentChromeApprovedHosts).toEqual(['plane.techflow.asia']);
  });
});

describe('chrome.do', () => {
  const stepperOf = (replies) => {
    const calls = [];
    return {
      calls,
      nextStep: vi.fn(async (body) => {
        calls.push(structuredClone(body));
        const next = replies.shift();
        if (next instanceof Error) throw next;
        return next;
      }),
    };
  };
  const reply = (step, extra = {}) => ({ step, decidedBy: ['typesafe/jev-1.13'], ms: 350, ...extra });

  it('works through the page until the platform says done, feeding back what it did', async () => {
    const stepper = stepperOf([
      reply({ action: 'select', ref: 'e4', target: 'combobox "ประเภทการลา"', value: 'ลาพักร้อน' }),
      reply({ action: 'fill', ref: 'e5', target: 'textbox "เหตุผล"', value: 'พาครอบครัวไปเที่ยว' }, { values: ['พาครอบครัวไปเที่ยว'] }),
      reply({ action: 'click', ref: 'e3', target: 'button "ส่งใบลา"' }),
      reply({ action: 'done' }),
    ]);
    const { service, run } = createService({ stepper });
    const result = await service.execute('chrome.do', { goal: 'ยื่นลาพักร้อน เหตุผล พาครอบครัวไปเที่ยว' }, '/repo', opts);
    expect(result).toMatchObject({ outcome: 'done', url: 'https://plane.techflow.asia/' });
    expect(result.steps.map((s) => s.step)).toEqual([
      'select combobox "ประเภทการลา" = "ลาพักร้อน"',
      'fill textbox "เหตุผล" = "พาครอบครัวไปเที่ยว"',
      'click button "ส่งใบลา"',
    ]);
    expect(run).toHaveBeenCalledWith(['select', '@e4', 'ลาพักร้อน'], expect.anything());
    expect(run).toHaveBeenCalledWith(['fill', '@e5', 'พาครอบครัวไปเที่ยว'], expect.anything());
    expect(run).toHaveBeenCalledWith(['click', '@e3'], expect.anything());
    expect(stepper.calls[2].history).toHaveLength(2);
    expect(stepper.calls[3].values).toEqual(['พาครอบครัวไปเที่ยว']);
    expect(stepper.calls[0].snapshot).toBe('- link "Home" [ref=e1]');
  });

  it('stops and hands the question back when the platform asks', async () => {
    const stepper = stepperOf([reply({ action: 'ask', question: 'ลูกค้าสยามรายไหน?' })]);
    const { service, run } = createService({ stepper });
    await expect(service.execute('chrome.do', { goal: 'ปิดดีลลูกค้าสยาม' }, '/repo', opts))
      .resolves.toMatchObject({ outcome: 'ask', question: 'ลูกค้าสยามรายไหน?', steps: [] });
    expect(run.mock.calls.some(([command]) => command[0] === 'click')).toBe(false);
  });

  it('stops when the same step comes back three times instead of looping', async () => {
    const same = () => reply({ action: 'click', ref: 'e1', target: 'link "Home"' });
    const stepper = stepperOf([same(), same(), same()]);
    const { service } = createService({ stepper });
    const result = await service.execute('chrome.do', { goal: 'x' }, '/repo', opts);
    expect(result).toMatchObject({ outcome: 'stuck' });
    expect(result.steps).toHaveLength(2);
  });

  it('stops at maxSteps', async () => {
    const stepper = stepperOf([
      reply({ action: 'click', ref: 'e1', target: 'link "A"' }),
      reply({ action: 'click', ref: 'e2', target: 'link "B"' }),
    ]);
    const { service } = createService({ stepper });
    await expect(service.execute('chrome.do', { goal: 'x', maxSteps: 2 }, '/repo', opts))
      .resolves.toMatchObject({ outcome: 'step_limit', steps: [{}, {}] });
  });

  it('reports a platform failure as where it stopped, keeping the steps already taken', async () => {
    const stepper = stepperOf([
      reply({ action: 'click', ref: 'e1', target: 'link "Home"' }),
      Object.assign(new Error('Sign in to Mittr first'), { statusCode: 401 }),
    ]);
    const { service } = createService({ stepper });
    await expect(service.execute('chrome.do', { goal: 'x' }, '/repo', opts))
      .resolves.toMatchObject({ outcome: 'stopped', reason: 'Sign in to Mittr first', steps: [{ step: 'click link "Home"' }] });
  });

  it('still refuses a page the user has not allowed', async () => {
    const { service } = createService({ stepper: stepperOf([]), pageUrl: 'https://evil.example/' });
    await expect(service.execute('chrome.do', { goal: 'x' }, '/repo', opts))
      .rejects.toMatchObject({ code: 'site_approval_required', host: 'evil.example' });
  });

  it('says what to do when the platform is not reachable from this install', async () => {
    const { service } = createService({ stepper: null });
    await expect(service.execute('chrome.do', { goal: 'x' }, '/repo', opts))
      .rejects.toMatchObject({ statusCode: 503 });
  });
});
