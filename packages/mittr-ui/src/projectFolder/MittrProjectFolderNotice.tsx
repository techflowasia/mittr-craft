import React from 'react';

import { toast } from '../../../ui/src/components/ui';
import { useProjectsStore } from '../../../ui/src/stores/useProjectsStore';
import { MittrErrorBoundary } from '../MittrErrorBoundary';
import type { MittrSurface } from '../mittrSurface';
import { mittrT } from '../strings/mittrT';
import { createProjectFolderApi } from './projectFolderApi';
import { createProjectFolderNotice, offerLine, outcomeLine, type ProjectFolderNotice, type ProjectFolderOffer, type ProjectFolderOutcome } from './projectFolderNotice';

const showOffer = (offer: ProjectFolderOffer): void => {
  const { title, description } = offerLine(offer);
  toast.info(title, {
    id: `mittr-project-folder:${offer.directory}`,
    description,
    duration: Number.POSITIVE_INFINITY,
    action: { label: mittrT('mittr.projectFolder.copy'), onClick: () => { void offer.copy(); } },
    cancel: { label: mittrT('mittr.projectFolder.dismiss'), onClick: () => { void offer.dismiss(); } },
  });
};

const showOutcome = (outcome: ProjectFolderOutcome): void => {
  const { failed, title, description } = outcomeLine(outcome);
  if (failed) toast.error(title, { description });
  else toast.success(title, description ? { description } : undefined);
};

const browserNotice = (): ProjectFolderNotice => createProjectFolderNotice({ api: createProjectFolderApi(), offer: showOffer, report: showOutcome });

export function ProjectFolderWatch({ createNotice = browserNotice }: { createNotice?: () => ProjectFolderNotice }): null {
  const [notice] = React.useState(createNotice);
  const directory = useProjectsStore((state) => state.projects.find((project) => project.id === state.activeProjectId)?.path ?? null);
  React.useEffect(() => {
    void notice.check(directory);
  }, [notice, directory]);
  return null;
}

export function MittrProjectFolderNotice({ surface }: { surface: MittrSurface }): React.ReactNode {
  if (surface !== 'main') return null;
  return (
    <MittrErrorBoundary fallback={null}>
      <ProjectFolderWatch />
    </MittrErrorBoundary>
  );
}
