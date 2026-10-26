import type { GoWorkProject, GoWorkSelection } from '../work/goWork';

type LaunchRefusal = 'no-project' | 'no-model' | 'no-mittr-model';

type LaunchPlan =
  | { ok: true; text: string; directory: string; selection: GoWorkSelection; project: GoWorkProject }
  | { ok: false; reason: LaunchRefusal; text: string; project: GoWorkProject | null };

export type LaunchDeps = {
  createSession: (directory: string, selection: GoWorkSelection) => Promise<{ id: string; directory?: string | null } | null>;
  initialize: (sessionId: string) => void;
  sendMessage: (text: string, selection: GoWorkSelection, sessionId: string, directory: string) => Promise<void>;
  openDraft: (text: string, project: GoWorkProject | null) => void;
  keepText: (text: string) => void;
  hide: () => void;
  refuse: (message: string) => void;
  fail: (message: string, description?: string) => void;
};

export type LaunchTexts = Record<LaunchRefusal, string> & { failed: string };

export function planLaunch({ text, project, selection, available }: {
  text: string;
  project: GoWorkProject | null;
  selection: GoWorkSelection | null;
  available: boolean | null;
}): LaunchPlan {
  const directory = project?.path.trim() ?? '';
  if (!project || !directory) return { ok: false, reason: 'no-project', text, project: null };
  if (!selection) return { ok: false, reason: 'no-model', text, project };
  if (available === false) return { ok: false, reason: 'no-mittr-model', text, project };
  return { ok: true, text, directory, selection, project };
}

export async function runLaunch(plan: LaunchPlan, deps: LaunchDeps, texts: LaunchTexts): Promise<'started' | 'refused' | 'failed'> {
  if (!plan.ok) {
    deps.refuse(texts[plan.reason]);
    deps.openDraft(plan.text, plan.project);
    deps.hide();
    return 'refused';
  }
  let session: Awaited<ReturnType<LaunchDeps['createSession']>>;
  try {
    session = await deps.createSession(plan.directory, plan.selection);
  } catch (error) {
    deps.fail(texts.failed, error instanceof Error ? error.message : String(error));
    deps.openDraft(plan.text, plan.project);
    deps.hide();
    return 'failed';
  }
  if (!session?.id) {
    deps.fail(texts.failed);
    deps.openDraft(plan.text, plan.project);
    deps.hide();
    return 'failed';
  }
  deps.initialize(session.id);
  deps.hide();
  try {
    await deps.sendMessage(plan.text, plan.selection, session.id, session.directory || plan.directory);
  } catch (error) {
    deps.fail(texts.failed, error instanceof Error ? error.message : String(error));
    deps.keepText(plan.text);
    return 'failed';
  }
  return 'started';
}
