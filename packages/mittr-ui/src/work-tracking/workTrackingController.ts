import { mittrT } from '../strings/mittrT';
import {
  IntegrationsRequestError,
  type IntegrationsApi,
  type IntegrationsConfig,
  type IntegrationsSaveBody,
  type IntegrationTestResult,
  type PlaneWorkspaceTest,
} from './integrationsApi';
import {
  addWorkspace,
  jiraFormOf,
  jiraSaveBody,
  planeFormOf,
  planeSaveBody,
  workspaceLimitOf,
  workspaceRefusalText,
  type JiraForm,
  type PlaneForm,
} from './workTrackingForm';

type WorkTrackingPlatform = 'jira' | 'plane';

export type WorkTrackingTask = 'saveJira' | 'savePlane' | 'testJira' | 'testPlane';

export type WorkTrackingState = {
  status: 'loading' | 'error' | 'ready';
  error: string | null;
  config: IntegrationsConfig | null;
  loadedFor: string | null;
  jira: JiraForm;
  plane: PlaneForm;
  newWorkspace: string;
  workspaceError: string | null;
  workspaceTests: Record<string, PlaneWorkspaceTest>;
  busy: readonly WorkTrackingTask[];
  savedNote: WorkTrackingPlatform | null;
  notice: string | null;
};

export type WorkTrackingOutcome = { tone: 'success' | 'error'; text: string } | null;

type WorkTrackingControllerDeps = {
  api: IntegrationsApi;
  currentUserId: () => string | null;
  listenAccountChanged: (onChange: () => void) => () => void;
};

export type WorkTrackingController = {
  state(): WorkTrackingState;
  subscribe(fn: () => void): () => void;
  refresh(): Promise<void>;
  editJira(patch: Partial<JiraForm>): void;
  editPlane(patch: Partial<Pick<PlaneForm, 'baseUrl' | 'apiKey'>>): void;
  editNewWorkspace(text: string): void;
  addWorkspace(): void;
  removeWorkspace(slug: string): void;
  saveJira(): Promise<WorkTrackingOutcome>;
  savePlane(): Promise<WorkTrackingOutcome>;
  testJira(): Promise<WorkTrackingOutcome>;
  testPlane(): Promise<WorkTrackingOutcome>;
  dispose(): void;
};

export const WORK_TRACKING_LOADING: WorkTrackingState = {
  status: 'loading',
  error: null,
  config: null,
  loadedFor: null,
  jira: { baseUrl: '', email: '', token: '' },
  plane: { baseUrl: '', workspaceSlugs: [], apiKey: '' },
  newWorkspace: '',
  workspaceError: null,
  workspaceTests: {},
  busy: [],
  savedNote: null,
  notice: null,
};

export function workTrackingStateFor(config: IntegrationsConfig | null, notice: string | null = null): WorkTrackingState {
  if (!config) return WORK_TRACKING_LOADING;
  if (!config.userId) return { ...WORK_TRACKING_LOADING, status: 'error', error: mittrT('mittr.workTracking.errors.loadFailed') };
  return {
    ...WORK_TRACKING_LOADING,
    status: 'ready',
    config,
    loadedFor: config.userId,
    jira: jiraFormOf(config.jira),
    plane: planeFormOf(config.plane),
    notice,
  };
}

const testOutcome = (platform: WorkTrackingPlatform, result: IntegrationTestResult): WorkTrackingOutcome => {
  if (!result.ok) return { tone: 'error', text: result.error || mittrT('mittr.workTracking.toast.testFailed') };
  if (platform === 'jira') {
    return { tone: 'success', text: mittrT('mittr.workTracking.toast.testOk', { name: result.displayName ?? result.email ?? '' }) };
  }
  const workspaces = result.workspaces ?? [];
  return {
    tone: 'success',
    text: workspaces.length > 1
      ? mittrT('mittr.workTracking.toast.testOkWorkspaces', { count: result.count ?? 0, workspaces: workspaces.length })
      : mittrT('mittr.workTracking.toast.testOkCount', { count: result.count ?? 0 }),
  };
};

const SAVE_TASK: Record<WorkTrackingPlatform, WorkTrackingTask> = { jira: 'saveJira', plane: 'savePlane' };
const TEST_TASK: Record<WorkTrackingPlatform, WorkTrackingTask> = { jira: 'testJira', plane: 'testPlane' };

export function createWorkTrackingController({ api, currentUserId, listenAccountChanged }: WorkTrackingControllerDeps): WorkTrackingController {
  let current = WORK_TRACKING_LOADING;
  let generation = 0;
  let reloadedForMismatch = false;
  let pendingNotice: string | null = null;
  let disposed = false;
  const listeners = new Set<() => void>();

  const set = (next: WorkTrackingState): void => {
    if (disposed || next === current) return;
    current = next;
    for (const listener of [...listeners]) listener();
  };

  const patch = (changes: Partial<WorkTrackingState>): void => set({ ...current, ...changes });

  const withoutTask = (task: WorkTrackingTask): readonly WorkTrackingTask[] => current.busy.filter((entry) => entry !== task);

  const load = async (): Promise<void> => {
    if (disposed) return;
    generation += 1;
    const request = generation;
    set(WORK_TRACKING_LOADING);
    let config: IntegrationsConfig;
    try {
      config = await api.load();
    } catch (error) {
      if (request === generation) {
        set({ ...WORK_TRACKING_LOADING, status: 'error', error: error instanceof Error ? error.message : mittrT('mittr.workTracking.errors.loadFailed') });
      }
      return;
    }
    if (request !== generation) return;
    if (config.userId !== currentUserId()) {
      if (reloadedForMismatch) return;
      reloadedForMismatch = true;
      await load();
      return;
    }
    reloadedForMismatch = false;
    const notice = pendingNotice;
    pendingNotice = null;
    set(workTrackingStateFor(config, notice));
  };

  const reloadForChangedAccount = (): Promise<void> => {
    reloadedForMismatch = false;
    pendingNotice = mittrT('mittr.workTracking.accountChanged');
    return load();
  };

  const noteRefusedForChangedAccount = (): void => {
    const notice = mittrT('mittr.workTracking.accountChanged');
    if (current.status === 'ready') patch({ notice });
    else pendingNotice = notice;
  };

  const ready = (): string | null => (current.status === 'ready' ? current.loadedFor : null);

  const save = async (platform: WorkTrackingPlatform): Promise<WorkTrackingOutcome> => {
    const loadedFor = ready();
    const task = SAVE_TASK[platform];
    if (!loadedFor || current.busy.includes(task)) return null;
    const body: IntegrationsSaveBody = platform === 'jira' ? jiraSaveBody(current.jira, loadedFor) : planeSaveBody(current.plane, loadedFor);
    const request = generation;
    patch({ busy: [...current.busy, task], savedNote: null, notice: null });
    let config: IntegrationsConfig;
    try {
      config = await api.save(body);
    } catch (error) {
      const accountChanged = error instanceof IntegrationsRequestError && error.status === 409;
      if (request !== generation) {
        if (accountChanged) noteRefusedForChangedAccount();
        return null;
      }
      if (accountChanged) {
        await reloadForChangedAccount();
        return null;
      }
      patch({ busy: withoutTask(task) });
      return { tone: 'error', text: error instanceof Error && error.message ? error.message : mittrT('mittr.workTracking.toast.saveFailed') };
    }
    if (request !== generation) return null;
    if (config.userId !== loadedFor) {
      await reloadForChangedAccount();
      return null;
    }
    patch({
      config,
      busy: withoutTask(task),
      savedNote: platform,
      ...(platform === 'jira' ? { jira: jiraFormOf(config.jira) } : { plane: planeFormOf(config.plane) }),
    });
    return null;
  };

  const runTest = async (platform: WorkTrackingPlatform): Promise<WorkTrackingOutcome> => {
    const loadedFor = ready();
    const task = TEST_TASK[platform];
    if (!loadedFor || current.busy.includes(task)) return null;
    const request = generation;
    patch({ busy: [...current.busy, task] });
    let result: IntegrationTestResult;
    try {
      result = await (platform === 'jira' ? api.testJira() : api.testPlane());
    } catch {
      result = { ok: false, error: mittrT('mittr.workTracking.toast.testFailed') };
    }
    if (request !== generation) return null;
    if (result.userId !== undefined && result.userId !== loadedFor) {
      await reloadForChangedAccount();
      return null;
    }
    patch({
      busy: withoutTask(task),
      ...(platform === 'plane' ? { workspaceTests: Object.fromEntries((result.workspaces ?? []).map((entry) => [entry.slug, entry])) } : {}),
    });
    return testOutcome(platform, result);
  };

  const editing = (changes: Partial<WorkTrackingState>): void => {
    if (current.status !== 'ready') return;
    patch({ ...changes, savedNote: null, notice: null });
  };

  const stopListening = listenAccountChanged(() => {
    reloadedForMismatch = false;
    void load();
  });

  return {
    state: () => current,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    refresh: () => {
      reloadedForMismatch = false;
      pendingNotice = null;
      return load();
    },
    editJira: (changes) => editing({ jira: { ...current.jira, ...changes } }),
    editPlane: (changes) => editing({ plane: { ...current.plane, ...changes } }),
    editNewWorkspace: (text) => editing({ newWorkspace: text, workspaceError: null }),
    addWorkspace: () => {
      if (current.status !== 'ready' || !current.config) return;
      const limit = workspaceLimitOf(current.config);
      const outcome = addWorkspace(current.plane.workspaceSlugs, current.newWorkspace, limit);
      if ('error' in outcome) {
        editing({ workspaceError: workspaceRefusalText(outcome, limit) });
        return;
      }
      editing({ plane: { ...current.plane, workspaceSlugs: outcome.list }, newWorkspace: '', workspaceError: null });
    },
    removeWorkspace: (slug) => editing({
      plane: { ...current.plane, workspaceSlugs: current.plane.workspaceSlugs.filter((entry) => entry !== slug) },
    }),
    saveJira: () => save('jira'),
    savePlane: () => save('plane'),
    testJira: () => runTest('jira'),
    testPlane: () => runTest('plane'),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      generation += 1;
      stopListening();
      listeners.clear();
    },
  };
}
