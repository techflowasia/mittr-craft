import { mittrT } from '../strings/mittrT';
import type { ProjectFolderApi } from './projectFolderApi';

export type ProjectFolderOffer = {
  directory: string;
  files: string[];
  copy: () => Promise<void>;
  dismiss: () => Promise<void>;
};

export type ProjectFolderOutcome =
  | { kind: 'copied'; copied: string[]; skipped: string[] }
  | { kind: 'failed'; reason: string };

export type ProjectFolderNotice = { check: (directory: string | null) => Promise<void> };

export function createProjectFolderNotice({ api, offer, report }: {
  api: ProjectFolderApi;
  offer: (offer: ProjectFolderOffer) => void;
  report: (outcome: ProjectFolderOutcome) => void;
}): ProjectFolderNotice {
  const checked = new Set<string>();
  return {
    check: async (directory) => {
      if (!directory || checked.has(directory)) return;
      checked.add(directory);
      const { offer: offered, files } = await api.status(directory);
      if (!offered || files.length === 0) return;
      offer({
        directory,
        files,
        copy: async () => {
          try {
            const { copied, skipped } = await api.copy(directory);
            report({ kind: 'copied', copied, skipped });
          } catch (error) {
            report({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) });
          }
        },
        dismiss: () => api.dismiss(directory),
      });
    },
  };
}

export type ToastLine = { title: string; description?: string };

export const offerLine = (offer: Pick<ProjectFolderOffer, 'files'>): ToastLine => ({
  title: mittrT('mittr.projectFolder.title'),
  description: offer.files.length === 1
    ? mittrT('mittr.projectFolder.descriptionOne')
    : mittrT('mittr.projectFolder.description', { count: offer.files.length }),
});

const copiedTitle = (count: number): string => {
  if (count === 0) return mittrT('mittr.projectFolder.copiedNone');
  if (count === 1) return mittrT('mittr.projectFolder.copiedOne');
  return mittrT('mittr.projectFolder.copied', { count });
};

export const outcomeLine = (outcome: ProjectFolderOutcome): ToastLine & { failed: boolean } => {
  if (outcome.kind === 'failed') return { failed: true, title: mittrT('mittr.projectFolder.failed'), description: outcome.reason };
  const line = { failed: false, title: copiedTitle(outcome.copied.length) };
  if (outcome.skipped.length === 0) return line;
  return { ...line, description: mittrT('mittr.projectFolder.skipped', { files: outcome.skipped.map((file) => `.opencode/${file}`).join(', ') }) };
};
