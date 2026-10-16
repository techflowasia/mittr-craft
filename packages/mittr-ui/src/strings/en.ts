import type { I18nDictionary } from '../../../ui/src/lib/i18n/store';

// Plain "OpenChamber" -> "MittrCraft" and "OpenCode" -> "MittrCraft" rewriting
// covers most strings. These are the English values where it would read wrong:
// a sentence that names the app and the engine apart, a third-party product
// whose name has to stay, or an engine version that is not the app's version.
export const strings: Partial<I18nDictionary> = {
  'opencodeCompatibility.bundled': 'The engine is bundled with MittrCraft. Update MittrCraft to get engine v2.',
  'opencodeCompatibility.outdatedLocal': 'Engine {version} is installed. This version of MittrCraft requires engine {minimum} or newer.',
  'opencodeCompatibility.local': 'Engine {version} is installed. This version of MittrCraft requires engine v2.',
  'opencodeCompatibility.installDescription': 'MittrCraft will install v2 using the official installer, then restart the engine.',
  'aboutDialog.openCodeVersionLabel': 'Engine version {version}',
  'aboutDialog.diagnosticsDescription': 'Includes MittrCraft state, engine health, directories, and projects.',
  'onboarding.localSetup.windows.stepSetBinaryPath': 'If MittrCraft does not detect the engine automatically, set the binary path below.',
  'onboarding.localSetup.helper.saveAndReload': 'Saves to MittrCraft settings and reloads the engine configuration.',
  'startup.initRecovery.openCodeUnavailable': 'MittrCraft is reachable, but the engine is not ready. Check the engine on the server, then retry.',
  'opencodeUpdate.toast.available.manualDescription': 'Version {version} available. Update the engine the way you installed it, then restart MittrCraft.',
  'settings.openchamber.about.openCode.manualUpdate': 'Engine {version} is available. Update the engine the way you installed it, then restart MittrCraft.',
  'settings.openchamber.opencodeCli.field.pinnedByAdministrator': 'Your administrator set this path, so MittrCraft always starts the engine from it.',
  'settings.openchamber.opencodeCli.restart.external': 'This engine was started outside MittrCraft. Restart it where you started it.',
  'settings.providers.page.custom.field.apiKey.info': 'Stored in the engine auth, not by MittrCraft. Use {env:VAR_NAME} to read a key from the environment instead.',
  'settings.providers.page.auth.apiKeyTooltip': 'Keys are sent directly to the engine and never stored by MittrCraft.',
  'settings.providers.enterprisePolicyConsole': 'Provider rules can also come from your OpenCode Console workspace, which MittrCraft can’t read.',
  'settings.common.legacyFormat.note': 'This file still uses the version 1 format. The next save rewrites it as version 2.',
  'settings.classification.source.zenPromo.name': 'OpenCode Zen promotion',
  'settings.classification.source.zenKey.name': 'OpenCode Zen key',
  'settings.classification.source.zenKey.missing': 'No Zen API key in the engine. Signing in with an OpenCode account does not count: add an API key to the OpenCode Zen provider.',
  'settings.sessions.permissions.explain.safetyUnavailable': 'Needs Jev, which needs a classification provider: the free OpenCode Zen promotion, a Zen API key in the engine, or a TypeSafe key.',
  'settings.providers.page.openCodeGo.title': 'OpenCode Go usage tracking',
  'settings.providers.page.openCodeGo.description': 'Connect the OpenCode Go dashboard to show rolling, weekly, and monthly quota.',
  'settings.providers.page.openCodeGo.saveFailed': 'Could not validate OpenCode Go credentials.',
  'settings.providers.page.openCodeGo.valid': 'OpenCode Go credentials are valid.',
  'settings.providers.page.openCodeGo.invalid': 'OpenCode Go credentials are invalid or expired.',
  'settings.providers.page.openCodeGo.deleted': 'OpenCode Go credentials deleted.',
  'settings.providers.page.openCodeGo.deleteFailed': 'Could not delete OpenCode Go credentials.',
};
