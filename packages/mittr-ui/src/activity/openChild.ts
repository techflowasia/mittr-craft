import type { useUIStore } from '@/stores/useUIStore';

type OpenContextPanelTab = ReturnType<typeof useUIStore.getState>['openContextPanelTab'];

export type OpenChildDeps = {
  directory: string | null;
  isMobile: boolean;
  isVSCode: boolean;
  setCurrentSession: (id: string, directory: string) => void;
  openContextPanelTab: (directory: string, tab: Parameters<OpenContextPanelTab>[1]) => void;
};

export const openChildSession = (deps: OpenChildDeps, childId: string, label: string): void => {
  if (!deps.directory) return;
  if (deps.isMobile || deps.isVSCode) {
    deps.setCurrentSession(childId, deps.directory);
    return;
  }
  deps.openContextPanelTab(deps.directory, { mode: 'chat', dedupeKey: `session:${childId}`, label, readOnly: true });
};
