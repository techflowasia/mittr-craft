import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What our layer relies on in upstream OpenChamber, one entry per thing that
 * could change under us without a merge conflict: a symbol, an environment
 * variable, a file we pin or a path the build packs. `upstream-contract.test.js`
 * holds one check per entry and fails when an entry and its check drift
 * apart, so an entry added here needs its check there.
 *
 * Run after every upstream merge (`scripts/mittr/upstream-update.mjs`). A
 * failure names what moved; read the upstream change before touching the
 * recorded value.
 */

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const ENGLISH_SNAPSHOT_FILE = 'packages/mittr-ui/src/strings/en.upstream-snapshot.json';

export const UPSTREAM_CONTRACT = [
  {
    id: 'managed-opencode-env',
    files: ['packages/web/server/lib/opencode/lifecycle.js', 'packages/web/server/index.js'],
    why: 'the server plugin engine env reaches every OpenCode start and CLI call through getManagedOpenCodeEnv',
  },
  {
    id: 'server-plugins-env',
    files: ['packages/web/server/lib/server-plugins.js', 'packages/web/server/index.js'],
    why: 'OPENCHAMBER_SERVER_PLUGINS names plugins the server loads before OpenCode starts',
  },
  {
    id: 'managed-config-contributions',
    files: ['packages/web/server/lib/opencode/managed-config-file.js', 'packages/web/server/index.js'],
    why: 'the config fragment server plugins return is written to the managed OPENCODE_CONFIG file, even when the user set OPENCODE_CONFIG, so project and user config cannot outrank its policies',
  },
  {
    id: 'plugin-context-express',
    files: ['packages/web/server/index.js'],
    why: 'server plugins get the express module the server itself runs on, since our package cannot import it',
  },
  {
    id: 'plugin-context-server-port',
    files: ['packages/web/server/index.js'],
    why: "the plugin context reports the server's bound port, null before listen",
  },
  {
    id: 'engine-on-ready',
    files: ['packages/web/server/lib/opencode/lifecycle.js', 'packages/web/server/index.js'],
    why: 'plugins hear about each managed OpenCode start and restart that reached ready',
  },
  {
    id: 'plugin-ui-event-broadcast',
    files: ['packages/web/server/index.js'],
    why: 'a plugin event goes out on the OpenChamber-owned UI event stream as { type, properties }',
  },
  {
    id: 'merge-engine-config',
    files: ['packages/web/server/lib/server-plugins.js', 'packages/web/server/index.js'],
    why: 'one merge rule for engine config fragments, exported and handed to plugins on the context',
  },
  {
    id: 'deep-link-registry-call-site',
    files: ['packages/electron/main.mjs', 'packages/electron/deep-link-registry.mjs'],
    why: "registered deep-link hosts are offered each link first, in the dispatcher's first statement, and the app keeps connect, focus, session and host",
  },
  {
    id: 'plugin-host-option',
    files: ['packages/electron/main.mjs', 'packages/electron/secret-store.mjs', 'packages/web/server/index.js'],
    why: 'the desktop shell passes pluginHost (a safeStorage secret store that checks availability only on first use, through available(), keeps a yes and asks again after a no once 5 s have passed, and the deep-link register) to startWebUiServer, which hands it to plugins as context.host',
  },
  {
    id: 'product-runtime-server-plugins',
    files: ['packages/electron/product-runtime.mjs', 'packages/electron/early-startup.mjs'],
    why: 'product.json serverPlugins and env reach the server through the desktop shell',
  },
  {
    id: 'server-app-version',
    files: ['packages/electron/product-runtime.mjs', 'packages/electron/product.mjs', 'packages/web/server/index.js'],
    why: 'product.json serverReportsAppVersion has the server report the packaged app version, which About shows',
  },
  {
    id: 'update-check-disabled-env',
    files: ['packages/web/server/lib/opencode/openchamber-routes.js'],
    why: 'OPENCHAMBER_UPDATE_CHECK_DISABLED keeps the update and usage check from calling upstream',
  },
  {
    id: 'models-metadata-disabled-env',
    files: ['packages/web/server/lib/opencode/openchamber-routes.js'],
    why: 'OPENCHAMBER_MODELS_METADATA_DISABLED makes /api/openchamber/models-metadata answer an empty catalog without fetching models.dev',
  },
  {
    id: 'policy-file-env',
    files: ['packages/web/server/lib/enterprise-mode.js'],
    why: 'OPENCHAMBER_POLICY_FILE replaces the OpenChamber policy path',
  },
  {
    id: 'managed-process-registry-env',
    files: ['packages/web/server/lib/opencode/managed-process-registry.js'],
    why: 'OPENCHAMBER_MANAGED_PROCESS_REGISTRY moves the managed process registry out of ~/.config/openchamber',
  },
  {
    id: 'git-identities-legacy-path',
    files: ['packages/web/server/lib/git/identity-storage.js', 'packages/mittr-server/src/git-identities.js'],
    why: 'upstream reads and locks ~/.config/openchamber only while <dataDir>/git-identities.json is missing, which our setup creates',
  },
  {
    id: 'integrate-tmp-root',
    files: ['packages/web/server/lib/git/service.js'],
    why: 'the integrate temp worktree follows OPENCHAMBER_DATA_DIR instead of ~/.config/openchamber',
  },
  {
    id: 'product-json-keys',
    files: ['packages/electron/product.mjs'],
    why: 'every product.json key we ship is one the desktop shell reads',
    keys: [
      'appName',
      'linuxDesktopName',
      'deepLinkProtocol',
      'appUserModelId',
      'desktopPort',
      'links',
      'updaterFeed',
      'splashSvg',
      'env',
      'envDefaults',
      'ensureDirs',
      'serverPlugins',
      'serverReportsAppVersion',
    ],
  },
  {
    id: 'plugin-routes-behind-api-auth',
    files: ['packages/web/server/index.js', 'packages/web/server/lib/opencode/bootstrap-runtime.js', 'packages/web/server/lib/opencode/core-routes.js'],
    why: 'routes a server plugin mounts under /api, Mittr sign-in among them, sit behind the API auth the server installs before it loads plugins',
  },
  {
    id: 'non-api-json-body',
    files: ['packages/web/server/lib/opencode/core-routes.js', 'packages/web/server/index.js'],
    why: 'the server parses JSON bodies outside /api before plugin routes run, and needs no UI session there, so the Mittr shim gets the engine request parsed',
  },
  {
    id: 'product-deep-link-scheme',
    files: ['packages/electron/early-startup.mjs', 'packages/electron/main.mjs', 'brand/product.dev.json', 'brand/product.prod.json'],
    why: 'the sign-in callback the server accepts is on the same URL scheme the desktop shell registers from the product',
  },
  {
    id: 'deep-link-raw',
    files: ['packages/electron/main.mjs'],
    why: 'the auth deep-link handler finishes sign-in from the full callback URL the shell keeps on the parsed link as raw',
  },
  {
    id: 'i18n-overlay',
    files: ['packages/ui/src/lib/i18n/store.ts', 'packages/ui/src/lib/product-plugins.ts'],
    why: 'every dictionary the UI shows goes through overlayDictionary',
  },
  {
    id: 'ui-plugin-glob',
    files: ['packages/ui/src/main.tsx', 'packages/ui/src/apps/renderElectronMiniChatApp.tsx'],
    why: 'both UI entry points import our product UI plugin through import.meta.glob',
    line: {
      'packages/ui/src/main.tsx': "import.meta.glob('../../*/src/product-ui-plugin.{ts,tsx}', { eager: true })",
      'packages/ui/src/apps/renderElectronMiniChatApp.tsx': "import.meta.glob('../../../*/src/product-ui-plugin.{ts,tsx}', { eager: true })",
    },
  },
  {
    id: 'ui-root-wrapper',
    files: ['packages/ui/src/main.tsx', 'packages/ui/src/apps/renderElectronMiniChatApp.tsx', 'packages/ui/src/lib/product-plugins.ts'],
    why: 'both UI entry points render the app inside ProductRoot, within SessionAuthGate, so our root wrapper and slots reach every surface',
    entries: {
      'packages/ui/src/main.tsx': { surface: 'main', app: '<App apis={runtimeAPIs} />' },
      'packages/ui/src/apps/renderElectronMiniChatApp.tsx': { surface: 'mini-chat', app: '<ElectronMiniChatApp apis={apis} />' },
    },
  },
  {
    id: 'desktop-bridge-listen',
    files: ['packages/electron/preload.mjs', 'packages/electron/main.mjs'],
    why: 'the sign-in gate hears the signed-in and sign-in-failed events a deep-link handler asks for through __OPENCHAMBER_DESKTOP__.listen, which main delivers on openchamber:emit',
  },
  {
    id: 'sign-in-gate-ui',
    files: [
      'packages/ui/src/lib/runtime-fetch.ts',
      'packages/ui/src/lib/url.ts',
      'packages/ui/src/components/ui/button.tsx',
      'packages/ui/src/main.tsx',
      'packages/ui/src/apps/renderElectronMiniChatApp.tsx',
    ],
    why: 'the sign-in gate reads the auth routes through runtimeFetch, opens the authorize URL with openExternalUrl, draws its actions with Button, and renders inside I18nProvider on both surfaces',
  },
  {
    id: 'english-overrides',
    files: ['packages/ui/src/lib/i18n/messages/en.ts', 'packages/mittr-ui/src/strings/en.ts', ENGLISH_SNAPSHOT_FILE],
    why: 'each English override still replaces the upstream text it was written against',
  },
  {
    id: 'after-pack-hook',
    files: ['packages/electron/scripts/after-pack.cjs'],
    why: 'the after-pack hook our build drops (afterPack: null) is the one we reviewed',
    file: 'packages/electron/scripts/after-pack.cjs',
    sha256: '197686364dd6bf7eea9c62728252c54c984a472833c4bcf9b12fd80c7f4b6c67',
  },
  {
    id: 'staged-server-packing',
    files: ['packages/electron/package.json', 'packages/electron/scripts/rebuild-native.mjs', 'scripts/mittr/build-desktop.mjs'],
    why: 'the staged server copy keeps git helpers and built-in extensions unpacked and leaves no native module behind',
    asarUnpack: [
      'node_modules/@openchamber/web/server/built-in-extensions/**/*',
      'node_modules/@openchamber/web/server/lib/git/credential-helper.js',
      'node_modules/@openchamber/web/server/lib/git/ssh-wrapper.js',
      'node_modules/@openchamber/web/server/lib/git/repository-credential-helper.js',
    ],
    nativeModules: ['node-pty', 'bun-pty'],
  },
  {
    id: 'opencode-user-config-io',
    files: ['packages/web/server/lib/opencode/shared.js', 'packages/web/server/index.js'],
    why: "plugins get the user's OpenCode config as opencode.userConfig: CONFIG_FILE under OPENCODE_CONFIG_DIR (else XDG_CONFIG_HOME/opencode), read with readConfigFile (a missing file is {}, a broken one throws) and written with writeConfig (other keys and comments kept, a broken file never overwritten); the Mittr default model is kept there",
  },
  {
    id: 'engine-integration-connect-key',
    files: ['node_modules/@opencode/client/package.json'],
    why: 'the engine stores a provider key through POST /api/integration/{id}/connect/key with a { key } body and answers 204, or 404 until a config-defined provider is picked up; the Mittr credential is stored that way',
  },
  {
    id: 'engine-credential-list-remove',
    files: ['node_modules/@opencode/client/package.json'],
    why: 'GET /api/credential answers { data: [{ id, integrationID, value }] } and DELETE /api/credential/{id} answers 204; the Mittr keys of earlier runs are removed that way',
  },
  {
    id: 'model-controls-product-picker',
    files: [
      'packages/ui/src/components/chat/ModelControls.tsx',
      'packages/ui/src/components/model-picker/ModelPickerList.tsx',
      'packages/ui/src/lib/product-plugins.ts',
    ],
    why: "ModelControls calls useProductModelPicker once, with the picker's open state, and lets only the providers it shows into the desktop list (isModelAllowed, which ModelPickerList applies to favorites, recents and providers) and into the mobile sheet",
  },
  {
    id: 'model-picker-blocked-entry',
    files: [
      'packages/ui/src/components/chat/ModelControls.tsx',
      'packages/ui/src/components/model-picker/ModelPickerList.tsx',
      'packages/ui/src/components/model-picker/ModelEntryStatusPill.tsx',
      'packages/ui/src/lib/product-plugins.ts',
    ],
    why: 'ModelPickerList takes isEntryBlocked and a blocked row is aria-disabled and chooses nothing on click, Enter or Space; ModelControls passes isEntryBlocked and composes renderRowEnd from the status pill of the picker decorations entryStatus and its own renderThinkingSlot',
  },
  {
    id: 'providers-page-slot',
    files: [
      'packages/ui/src/components/sections/providers/ProviderGrid.tsx',
      'packages/ui/src/components/sections/providers/ProvidersPage.tsx',
      'packages/ui/src/lib/product-plugins.ts',
    ],
    why: "the providers page opens on the provider grid, which renders the providers-page slot once, inside its page layout above the provider cards; the provider switch lives there",
  },
  {
    id: 'provider-switch-ui',
    files: ['packages/ui/src/components/ui/switch.tsx', 'packages/ui/src/components/sections/shared/SettingsSection.tsx'],
    why: 'the provider switch is drawn with Switch (checked, onCheckedChange, disabled, loading) in a SettingsFieldRow with a visible description',
  },
  {
    id: 'policy-schema',
    files: ['node_modules/@opencode/schema/dist/config/experimental.js', 'node_modules/@opencode/schema/dist/config/policy.js'],
    why: 'the engine config takes experimental.policies, an ordered list of { action: "provider.use", resource, effect: "allow" | "deny" }, which is how the provider lock is written',
  },
  {
    id: 'model-controls-add-provider-row',
    files: ['packages/ui/src/components/chat/ModelControls.tsx', 'packages/ui/src/lib/product-plugins.ts'],
    why: 'the picker draws its "Add new provider" row only while the composed picker decorations do not say offersAddProvider: false, and one plugin saying false withholds it',
  },
  {
    id: 'ui-remote-model-catalog',
    files: [
      'packages/ui/src/lib/product-plugins.ts',
      'packages/ui/src/hooks/useProviderLogo.ts',
      'packages/ui/src/stores/useConfigStore.ts',
    ],
    why: 'a product plugin with remoteModelCatalog: false keeps the window from fetching models.dev: the metadata load asks only the server route, and a provider logo the UI does not bundle is none instead of a models.dev URL',
  },
  {
    id: 'engine-outbound-switches',
    files: ['packages/electron/package.json'],
    why: 'the bundled engine (OpenCode 2.0.22) reads OPENCODE_DISABLE_MODELS_FETCH, which stops its models.opencode.ai catalog download, and OPENCODE_DISABLE_AUTOUPDATE, which stops its update check; engineEnv sets both, and probe --only outbound (scripts/mittr/probe-engine-v2.mjs) shows no egress with them and models.opencode.ai without them, so a new engine version needs that probe run again',
  },
  {
    id: 'engine-share-config',
    files: ['node_modules/@opencode/schema/dist/config.js'],
    why: 'the engine config takes share: "manual" | "auto" | "disabled"; the managed config sets "disabled" so no engine session is ever shared',
  },
  {
    id: 'engine-identity-hook',
    files: ['packages/electron/package.json'],
    why: "the bundled engine is OpenCode 2.0.22, whose session context hook hands plugins the system prompt as o.system text parts opening with its harness sentence; the identity plugin rewrites that sentence, so a new engine version needs probe P3 (scripts/mittr/probe-engine-v2.mjs) run again before this pin moves",
  },
  {
    id: 'engine-launched-data-home',
    files: ['packages/web/server/lib/opencode/lifecycle.js', 'packages/web/server/index.js'],
    why: "the plugin context's opencode.launchedDataHome() is the XDG_DATA_HOME the managed OpenCode process was last launched with (null for an external server), recorded from the very env it is spawned with, so a plugin can see which data folder the running engine is on",
  },
  {
    id: 'engine-refresh-restarts',
    files: ['packages/web/server/lib/opencode/lifecycle.js', 'packages/web/server/index.js'],
    why: "a plugin's opencode.refresh(reason) restarts the managed OpenCode and waits for it to be ready, and that restart reads the plugins' engine env again, so a Mittr account switch moves the engine onto the account's home; a refresh that lands while another restart is under way joins it instead, and that restart may have read the env before the switch, so the switcher checks opencode.launchedDataHome() afterwards and refreshes once more when the engine came up elsewhere",
  },
  {
    id: 'sidebar-footer-slot',
    files: ['packages/ui/src/components/session/sidebar/shell/SidebarFooter.tsx', 'packages/ui/src/lib/product-plugins.ts'],
    why: 'the sidebar footer renders the sidebar-footer slot once, after its settings, usage, shortcuts and about buttons and before the update button; the account menu lives there',
  },
  {
    id: 'sidebar-footer-visible-on-desktop',
    files: ['packages/ui/src/components/session/sidebar/shell/SidebarFooter.tsx', 'packages/ui/src/components/session/SessionSidebar.tsx'],
    why: 'the session sidebar renders its footer once, with the runtime buttons (and so the sidebar-footer slot) shown everywhere but VS Code, so the account menu is there on desktop',
  },
  {
    id: 'about-dialog-slot',
    files: ['packages/ui/src/components/ui/AboutDialog.tsx', 'packages/ui/src/App.tsx', 'packages/ui/src/lib/product-plugins.ts'],
    why: 'the About dialog the app opens renders the about-dialog slot once, under its version lines; the sign-out button lives there',
  },
  {
    id: 'about-settings-slot',
    files: ['packages/ui/src/components/sections/openchamber/AboutSettings.tsx', 'packages/ui/src/lib/product-plugins.ts'],
    why: "the About settings page renders the about-settings slot once, in its desktop layout after the update rows and before the instance addresses; the sign-out row lives there, and the phone layout has none",
  },
  {
    id: 'model-controls-auto-entry',
    files: ['packages/ui/src/components/chat/ModelControls.tsx', 'packages/ui/src/lib/routing/autoModel.ts'],
    why: "the composer's Auto entry (provider openchamber) is offered on desktop and in the mobile sheet only while the picker decorations show that provider, so the Mittr lock hides it while other providers are off",
  },
  {
    id: 'config-store-fresh-providers',
    files: ['packages/ui/src/stores/useConfigStore.ts', 'packages/ui/src/lib/opencode/client.ts'],
    why: "useConfigStore.getState().loadProviders({ fresh: true }) waits out a provider read already in flight and reads the engine's providers and models again, so the picker takes up a provider switch saved here or in another window",
  },
  {
    id: 'quota-provider-registry',
    files: ['packages/web/server/lib/quota/providers/index.js', 'packages/web/server/lib/quota/providers/registered.js', 'packages/web/server/lib/quota/utils/formatters.js', 'packages/web/server/index.js'],
    why: "a server plugin adds and removes a quota provider through registerQuotaProvider on the plugin context, and builds its result with the buildResult and toUsageWindow the context hands it as quotaResult, so the Usage page lists it beside upstream's own",
  },
  {
    id: 'quota-ui-registry',
    files: ['packages/ui/src/lib/quota/providers/index.ts'],
    why: 'registerQuotaProvider adds a usage provider to the Usage page at run time and selectRegisteredQuotaProvider passes a registered id to the setter it is given, so the Usage page opens on the Mittr provider',
  },
  {
    id: 'quota-store-selection',
    files: ['packages/ui/src/stores/useQuotaStore.ts', 'packages/ui/src/components/sections/usage/UsagePage.tsx'],
    why: 'useQuotaStore keeps selectedProviderId and setSelectedProvider, and the Usage page picks a provider itself only while selectedProviderId is null, so a provider chosen before it opens is kept',
  },
  {
    id: 'settings-search-usage',
    files: ['packages/ui/src/lib/settings/search.ts', 'packages/ui/src/lib/settings/metadata.ts', 'packages/ui/src/lib/i18n/messages/en.settings.ts'],
    why: "the usage.model-quotas search item is titled by settings.usage.page.section.modelQuotas, which our English override renames to Weekly model quotas, and the Usage page's own search keywords include quota",
  },
  {
    id: 'account-menu-ui',
    files: [
      'packages/ui/src/components/ui/dropdown-menu.tsx',
      'packages/ui/src/components/ui/tooltip.tsx',
      'packages/ui/src/components/ui/dialog.tsx',
      'packages/ui/src/components/ui/index.ts',
      'packages/ui/src/components/icon/sprite.ts',
      'packages/ui/src/components/sections/shared/SettingsSection.tsx',
      'packages/ui/src/components/session/sidebar/shell/SidebarFooter.tsx',
    ],
    why: 'the account button wears the sidebar footer buttons\' own classes, copied; the account menu is drawn with DropdownMenu (open, onOpenChange, items with onClick, label, separator) inside a Tooltip, the switch wait state with a Dialog whose close button can be left out, messages with toast, and the check, user and loader icons; the About row uses SETTINGS_FIELD_LABEL_CLASS',
  },
];

// The dictionaries are TypeScript with extensionless imports, which only Bun
// loads directly, so they are read in a Bun child process.
const ENGLISH_PROBE = `
  const { dict } = await import(process.env.UPSTREAM_EN);
  const { strings } = await import(process.env.OVERRIDES_EN);
  const upstream = Object.fromEntries(Object.keys(strings).filter((key) => key in dict).map((key) => [key, dict[key]]));
  console.log(JSON.stringify({ overrides: strings, upstream }));
`;

/** Our English overrides and, for each key upstream still has, upstream's English text. */
export const readEnglishOverrides = ({ root = repoRoot, bun = process.env.BUN_EXECUTABLE || 'bun' } = {}) => {
  const result = spawnSync(bun, ['-e', ENGLISH_PROBE], {
    encoding: 'utf8',
    env: {
      ...process.env,
      UPSTREAM_EN: path.join(root, 'packages/ui/src/lib/i18n/messages/en.ts'),
      OVERRIDES_EN: path.join(root, 'packages/mittr-ui/src/strings/en.ts'),
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`reading the English dictionaries failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
};

/** The snapshot to commit: upstream's English text for every key we override. */
export const englishSnapshot = ({ overrides, upstream }) => Object.fromEntries(
  Object.keys(overrides).filter((key) => key in upstream).map((key) => [key, upstream[key]]),
);

/**
 * One line per override to re-check: upstream reworded the text it replaces,
 * dropped the key, or the snapshot and the overrides list different keys.
 */
export const compareEnglishSnapshot = (snapshot, { overrides, upstream }) => {
  const problems = [];
  for (const key of Object.keys(overrides)) {
    const inSnapshot = Object.hasOwn(snapshot, key);
    if (!Object.hasOwn(upstream, key)) {
      problems.push(`${key}: no longer exists upstream${inSnapshot ? ` (was ${JSON.stringify(snapshot[key])})` : ''}`);
    } else if (!inSnapshot) {
      problems.push(`${key}: overridden but not in the snapshot (upstream ${JSON.stringify(upstream[key])})`);
    } else if (snapshot[key] !== upstream[key]) {
      problems.push(`${key}: upstream English changed from ${JSON.stringify(snapshot[key])} to ${JSON.stringify(upstream[key])}`);
    }
  }
  for (const key of Object.keys(snapshot)) {
    if (!Object.hasOwn(overrides, key)) problems.push(`${key}: in the snapshot but no longer overridden`);
  }
  return problems;
};
