import { describe, expect, test } from 'bun:test';

import { mittrT } from '../strings/mittrT';
import { ToolsRequestError, type ChromeProfile, type MittrTools, type ToolsApi, type ToolsPatch } from './toolsApi';
import { createToolsController, TOOLS_LOADING } from './toolsController';

type Deferred<T> = { resolve: (value: T) => void; reject: (error: Error) => void };

const toolsWith = (chrome: Partial<MittrTools['chrome']> = {}, computer: Partial<MittrTools['computer']> = {}): MittrTools => ({
  computer: { offered: true, enabled: true, ...computer },
  chrome: { offered: true, chromeInstalled: true, enabled: true, profile: 'Default', headed: false, approvedHosts: ['jira.acme.test', 'plane.acme.test'], ...chrome },
});

const PROFILES: ChromeProfile[] = [{ directory: 'Default', name: 'Person' }, { directory: 'Profile 1', name: 'Work' }];

const setup = () => {
  const loads: Deferred<MittrTools>[] = [];
  const saves: Array<Deferred<MittrTools> & { patch: ToolsPatch }> = [];
  const profiles: Deferred<ChromeProfile[]>[] = [];
  const removals: Array<Deferred<string[]> & { host: string }> = [];
  const api: ToolsApi = {
    load: () => new Promise((resolve, reject) => { loads.push({ resolve, reject }); }),
    save: (patch) => new Promise((resolve, reject) => { saves.push({ resolve, reject, patch }); }),
    profiles: () => new Promise((resolve, reject) => { profiles.push({ resolve, reject }); }),
    removeHost: (host) => new Promise((resolve, reject) => { removals.push({ resolve, reject, host }); }),
  };
  const controller = createToolsController({ api });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const ready = async (tools: MittrTools = toolsWith(), list: ChromeProfile[] = PROFILES) => {
    const loading = controller.load();
    loads.at(-1)?.resolve(tools);
    await loading;
    await settle();
    profiles.at(-1)?.resolve(list);
    await settle();
  };
  return { controller, loads, saves, profiles, removals, settle, ready };
};

const toolsOf = (state: ReturnType<ReturnType<typeof createToolsController>['state']>) => (state.tools.status === 'ready' ? state.tools.tools : null);

describe('MittrCraft tools controller', () => {
  test('it starts loading, reads the tools, then the Chrome profiles while Chrome is on', async () => {
    const { controller, profiles, ready } = setup();
    expect(controller.state()).toEqual(TOOLS_LOADING);
    await ready();
    expect(controller.state()).toEqual({ tools: { status: 'ready', tools: toolsWith() }, profiles: { status: 'ready', list: PROFILES } });
    expect(profiles).toHaveLength(1);
  });

  test('profiles are not read while Chrome is off or not installed, and are read once it is turned on', async () => {
    for (const chrome of [{ enabled: false }, { chromeInstalled: false }, { offered: false }]) {
      const { controller, profiles, ready } = setup();
      await ready(toolsWith(chrome));
      expect(profiles).toHaveLength(0);
      expect(controller.state().profiles).toEqual({ status: 'idle' });
    }
    const { controller, profiles, saves, ready, settle } = setup();
    await ready(toolsWith({ enabled: false }));
    const turning = controller.setChrome(true);
    expect(saves[0].patch).toEqual({ chrome: true });
    saves[0].resolve(toolsWith());
    expect(await turning).toBeNull();
    await settle();
    expect(profiles).toHaveLength(1);
    expect(controller.state().profiles).toEqual({ status: 'loading' });
  });

  test('a failed write reloads the stored state', async () => {
    const { controller, loads, saves, ready, settle } = setup();
    await ready();

    const writing = controller.setChrome(false);
    expect(toolsOf(controller.state())?.chrome.enabled).toBe(false);
    saves[0].reject(new ToolsRequestError('Cannot store the tool setting on this machine', 500));
    expect(await writing).toEqual({ tone: 'error', text: 'Cannot store the tool setting on this machine' });

    expect(loads).toHaveLength(2);
    loads[1].resolve(toolsWith());
    await settle();
    expect(toolsOf(controller.state())?.chrome.enabled).toBe(true);
  });

  test('a slow load never overwrites a newer one', async () => {
    const { controller, loads, saves, ready, settle } = setup();
    await ready();

    const reloading = controller.load();
    const writing = controller.setComputer(false);
    saves[0].resolve(toolsWith({}, { enabled: false }));
    await writing;
    expect(toolsOf(controller.state())?.computer.enabled).toBe(false);

    loads[1].resolve(toolsWith());
    await reloading;
    await settle();
    expect(toolsOf(controller.state())?.computer.enabled).toBe(false);

    const first = controller.setHeaded(true);
    const second = controller.setHeaded(false);
    saves[2].resolve(toolsWith({ headed: false }));
    await second;
    saves[1].resolve(toolsWith({ headed: true }));
    await first;
    expect(toolsOf(controller.state())?.chrome.headed).toBe(false);
  });

  test('a profile change sends only the profile and shows it at once', async () => {
    const { controller, saves, ready } = setup();
    await ready();
    const choosing = controller.setProfile('Profile 1');
    expect(saves[0].patch).toEqual({ chromeProfile: 'Profile 1' });
    expect(toolsOf(controller.state())?.chrome.profile).toBe('Profile 1');
    saves[0].resolve(toolsWith({ profile: 'Profile 1' }));
    expect(await choosing).toBeNull();
  });

  test('removing a site takes it off the list and keeps what the server answers', async () => {
    const { controller, removals, loads, ready, settle } = setup();
    await ready();

    const removing = controller.removeHost('jira.acme.test');
    expect(removals[0].host).toBe('jira.acme.test');
    expect(toolsOf(controller.state())?.chrome.approvedHosts).toEqual(['plane.acme.test']);
    removals[0].resolve(['plane.acme.test']);
    expect(await removing).toBeNull();

    const failing = controller.removeHost('plane.acme.test');
    removals[1].reject(new ToolsRequestError(mittrT('mittr.tools.errors.removeFailed', { host: 'plane.acme.test' }), null));
    expect(await failing).toEqual({ tone: 'error', text: 'Could not remove plane.acme.test' });
    loads.at(-1)?.resolve(toolsWith({ approvedHosts: ['plane.acme.test'] }));
    await settle();
    expect(toolsOf(controller.state())?.chrome.approvedHosts).toEqual(['plane.acme.test']);
  });

  test('a failed read shows its error, and a failed profile list is not shown as no profiles', async () => {
    const { controller, loads, profiles, settle } = setup();
    const loading = controller.load();
    loads[0].reject(new ToolsRequestError('Could not load the MittrCraft tools settings', 500));
    await loading;
    expect(controller.state().tools).toEqual({ status: 'error', error: 'Could not load the MittrCraft tools settings' });

    const again = controller.load();
    loads[1].resolve(toolsWith());
    await again;
    profiles[0].reject(new ToolsRequestError('Could not list the Chrome profiles on this Mac', 502));
    await settle();
    expect(controller.state().profiles).toEqual({ status: 'error', error: 'Could not list the Chrome profiles on this Mac' });
  });

  test('nothing changes after dispose', async () => {
    const { controller, loads, settle } = setup();
    let notified = 0;
    controller.subscribe(() => { notified += 1; });
    const loading = controller.load();
    controller.dispose();
    loads[0].resolve(toolsWith());
    await loading;
    await settle();
    expect(controller.state()).toEqual(TOOLS_LOADING);
    expect(notified).toBe(0);
    expect(await controller.setChrome(false)).toBeNull();
  });
});
