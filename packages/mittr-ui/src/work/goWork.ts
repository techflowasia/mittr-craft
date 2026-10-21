import { agentEntryStatus } from '../quota/agentStatus';
import type { AgentStatus } from '../quota/quotaMeStore';
import { MITTR_PROVIDER_ID } from '../mittrProvider';
import { mittrT, type MittrKey } from '../strings/mittrT';
import { cardKeyOf, type WorkItem } from './workItems';

export type GoWorkSelection = { providerID: string; modelID: string; agentName?: string; variant?: string };

export type GoWorkProject = { id: string; path: string; label?: string };

export type GoWorkRefusal = 'no-project' | 'no-model' | 'no-mittr-model';

export type GoWorkPlan =
  | { ok: true; title: string; prompt: string; directory: string; selection: GoWorkSelection }
  | { ok: false; reason: GoWorkRefusal };

export type GoWorkToast = {
  success: (message: string) => void;
  error: (message: string, options?: { description?: string }) => void;
};

export type GoWorkDeps = {
  createSession: (title: string, directory: string, selection: GoWorkSelection) => Promise<{ id: string; directory?: string | null } | null>;
  initialize: (sessionId: string) => void;
  sendMessage: (prompt: string, selection: GoWorkSelection, sessionId: string, directory: string) => Promise<void>;
  closeDialog: () => void;
  toast: GoWorkToast;
};

const REFUSAL_TEXT = {
  'no-project': 'mittr.work.projectMenu.empty',
  'no-model': 'mittr.work.error.noModelSelected',
  'no-mittr-model': 'mittr.work.error.noMittrModel',
} satisfies Record<GoWorkRefusal, MittrKey>;

export const goWorkPrompt = (item: WorkItem): string => {
  const key = item.source === 'plane' ? null : cardKeyOf(item);
  const url = item.url ?? '';
  return key
    ? `อ่าน Jira issue ${key} (${item.title}) ที่ ${url} แล้วบอกว่าต้องทำอะไร`
    : `อ่านงาน "${item.title}" ที่ ${url} แล้วบอกว่าต้องทำอะไร`;
};

export const mittrCatalogAliases = (
  providers: readonly { id: string; models: readonly { id: string }[] }[],
): string[] => providers.find((provider) => provider.id === MITTR_PROVIDER_ID)?.models.map((model) => model.id) ?? [];

export function mittrAvailable(
  selection: GoWorkSelection | null,
  catalogAliases: readonly string[],
  agentStatus: ReadonlyMap<string, AgentStatus> | null,
): boolean | null {
  if (selection?.providerID !== MITTR_PROVIDER_ID) return true;
  if (!agentStatus || catalogAliases.length === 0) return null;
  return !catalogAliases.every((alias) => agentEntryStatus(agentStatus.get(alias), alias)?.blocked === true);
}

export function planGoWork({ item, project, selection, available }: {
  item: WorkItem;
  project: GoWorkProject | null;
  selection: GoWorkSelection | null;
  available: boolean | null;
}): GoWorkPlan {
  const directory = project?.path.trim() ?? '';
  if (!directory) return { ok: false, reason: 'no-project' };
  if (!selection) return { ok: false, reason: 'no-model' };
  if (available === false) return { ok: false, reason: 'no-mittr-model' };
  return { ok: true, title: item.title, prompt: goWorkPrompt(item), directory, selection };
}

export async function runGoWork(plan: GoWorkPlan, deps: GoWorkDeps): Promise<'started' | 'failed'> {
  if (!plan.ok) {
    deps.toast.error(mittrT(REFUSAL_TEXT[plan.reason]));
    return 'failed';
  }
  let session: Awaited<ReturnType<GoWorkDeps['createSession']>>;
  try {
    session = await deps.createSession(plan.title, plan.directory, plan.selection);
  } catch (error) {
    deps.toast.error(mittrT('mittr.work.toast.startFailed'), { description: error instanceof Error ? error.message : String(error) });
    return 'failed';
  }
  if (!session?.id) {
    deps.toast.error(mittrT('mittr.work.toast.startFailed'));
    return 'failed';
  }
  deps.initialize(session.id);
  deps.closeDialog();
  try {
    await deps.sendMessage(plan.prompt, plan.selection, session.id, session.directory || plan.directory);
  } catch (error) {
    deps.toast.error(mittrT('mittr.work.toast.startFailed'), { description: error instanceof Error ? error.message : String(error) });
    return 'failed';
  }
  deps.toast.success(mittrT('mittr.work.toast.sessionCreated'));
  return 'started';
}
