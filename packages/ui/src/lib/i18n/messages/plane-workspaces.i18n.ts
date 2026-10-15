const en = {
  'settings.integrations.workTracking.plane.token': 'Personal access token',
  'settings.integrations.workTracking.plane.workspaces': 'Workspaces',
  'settings.integrations.workTracking.plane.workspacesHint':
    'One token reaches every workspace you belong to. Add each workspace by the name in its address — techflow in plane.example.com/techflow.',
  'settings.integrations.workTracking.plane.newWorkspace': 'Workspace to add',
  'settings.integrations.workTracking.plane.addWorkspace': 'Add',
  'settings.integrations.workTracking.plane.removeWorkspace': 'Remove {slug}',
  'settings.integrations.workTracking.plane.noWorkspaces': 'No workspace yet. Add at least one.',
  'settings.integrations.workTracking.plane.duplicateWorkspace': '{slug} is already in the list',
  'settings.integrations.workTracking.plane.workspaceOk': '{count} projects',
  'settings.integrations.workTracking.plane.workspaceFailed': 'Cannot open: {error}',
  'settings.integrations.workTracking.plane.unsaved': 'Not saved yet',
  'settings.integrations.workTracking.toast.testOkWorkspaces': 'Connected — {count} projects in {workspaces} workspaces',
  'sessions.myWork.dialog.source.planeWorkspace': 'Plane workspace {workspace}',
} as const;

export const planeWorkspacesI18n = {
  en,
  de: en,
  fr: en,
  es: en,
  ja: en,
  ko: en,
  pl: en,
  'pt-BR': en,
  uk: en,
  'zh-CN': en,
  'zh-TW': en,
} as const;
