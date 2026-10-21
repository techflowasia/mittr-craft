import { mittrT } from '../strings/mittrT';
import type { ChromeProfile, MittrTools, ToolsApi, ToolsPatch } from './toolsApi';

export type ToolsLoad =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; tools: MittrTools };

export type ProfilesLoad =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; list: ChromeProfile[] };

export type ToolsControllerState = { tools: ToolsLoad; profiles: ProfilesLoad };

export type ToolsOutcome = { tone: 'error'; text: string } | null;

export type ToolsController = {
  state(): ToolsControllerState;
  subscribe(fn: () => void): () => void;
  load(): Promise<void>;
  setComputer(on: boolean): Promise<ToolsOutcome>;
  setChrome(on: boolean): Promise<ToolsOutcome>;
  setProfile(directory: string): Promise<ToolsOutcome>;
  setHeaded(on: boolean): Promise<ToolsOutcome>;
  removeHost(host: string): Promise<ToolsOutcome>;
  dispose(): void;
};

export const TOOLS_LOADING: ToolsControllerState = { tools: { status: 'loading' }, profiles: { status: 'idle' } };

const messageOf = (error: Error | null, fallback: string): string => error?.message || fallback;

const needsProfiles = ({ chrome }: MittrTools): boolean => chrome.offered && chrome.chromeInstalled && chrome.enabled;

type ChromeChange = Partial<MittrTools['chrome']>;

const withChrome = (tools: MittrTools, change: ChromeChange): MittrTools => ({ ...tools, chrome: { ...tools.chrome, ...change } });

export function createToolsController({ api }: { api: ToolsApi }): ToolsController {
  let current = TOOLS_LOADING;
  let generation = 0;
  let profilesGeneration = 0;
  let disposed = false;
  const listeners = new Set<() => void>();

  const set = (next: ToolsControllerState): void => {
    if (disposed || next === current) return;
    current = next;
    for (const listener of [...listeners]) listener();
  };

  const readyTools = (): MittrTools | null => (current.tools.status === 'ready' ? current.tools.tools : null);

  const loadProfiles = async (): Promise<void> => {
    profilesGeneration += 1;
    const request = profilesGeneration;
    set({ ...current, profiles: { status: 'loading' } });
    let list: ChromeProfile[];
    try {
      list = await api.profiles();
    } catch (error) {
      if (request === profilesGeneration) set({ ...current, profiles: { status: 'error', error: messageOf(error instanceof Error ? error : null, mittrT('mittr.tools.errors.profilesFailed')) } });
      return;
    }
    if (request === profilesGeneration) set({ ...current, profiles: { status: 'ready', list } });
  };

  const show = (tools: MittrTools, { freshProfiles }: { freshProfiles: boolean }): void => {
    set({ ...current, tools: { status: 'ready', tools } });
    if (!needsProfiles(tools)) return;
    if (freshProfiles || current.profiles.status === 'idle') void loadProfiles();
  };

  const load = async (): Promise<void> => {
    if (disposed) return;
    generation += 1;
    const request = generation;
    if (current.tools.status === 'error') set({ ...current, tools: { status: 'loading' } });
    let tools: MittrTools;
    try {
      tools = await api.load();
    } catch (error) {
      if (request === generation) set({ ...current, tools: { status: 'error', error: messageOf(error instanceof Error ? error : null, mittrT('mittr.tools.errors.loadFailed')) } });
      return;
    }
    if (request === generation) show(tools, { freshProfiles: true });
  };

  const write = async (shown: MittrTools, send: () => Promise<MittrTools | null>, fallback: string, freshProfiles = false): Promise<ToolsOutcome> => {
    generation += 1;
    const request = generation;
    set({ ...current, tools: { status: 'ready', tools: shown } });
    let answered: MittrTools | null;
    try {
      answered = await send();
    } catch (error) {
      if (disposed || request !== generation) return null;
      void load();
      return { tone: 'error', text: messageOf(error instanceof Error ? error : null, fallback) };
    }
    if (answered && request === generation) show(answered, { freshProfiles });
    return null;
  };

  const change = (patch: ToolsPatch, shownOf: (tools: MittrTools) => MittrTools): Promise<ToolsOutcome> => {
    const tools = readyTools();
    if (disposed || !tools) return Promise.resolve(null);
    const turnsChromeOn = patch.chrome === true && !tools.chrome.enabled;
    return write(shownOf(tools), () => api.save(patch), mittrT('mittr.tools.errors.saveFailed'), turnsChromeOn);
  };

  const removeHost = (host: string): Promise<ToolsOutcome> => {
    const tools = readyTools();
    if (disposed || !tools) return Promise.resolve(null);
    const shown = withChrome(tools, { approvedHosts: tools.chrome.approvedHosts.filter((entry) => entry !== host) });
    return write(shown, async () => {
      const hosts = await api.removeHost(host);
      const latest = readyTools();
      return latest ? withChrome(latest, { approvedHosts: hosts }) : null;
    }, mittrT('mittr.tools.errors.removeFailed', { host }));
  };

  return {
    state: () => current,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    load,
    setComputer: (on) => change({ computer: on }, (tools) => ({ ...tools, computer: { ...tools.computer, enabled: on } })),
    setChrome: (on) => change({ chrome: on }, (tools) => withChrome(tools, { enabled: on })),
    setProfile: (directory) => change({ chromeProfile: directory }, (tools) => withChrome(tools, { profile: directory })),
    setHeaded: (on) => change({ chromeHeaded: on }, (tools) => withChrome(tools, { headed: on })),
    removeHost,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      generation += 1;
      profilesGeneration += 1;
      listeners.clear();
    },
  };
}
