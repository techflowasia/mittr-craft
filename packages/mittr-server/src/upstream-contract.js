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
    id: 'git-remote-url',
    files: ['packages/web/server/lib/git/service.js', 'packages/web/server/index.js'],
    why: "the plugin context's git.remoteUrl(directory) is the service's getRemoteUrl(directory, 'origin'): the remote's URL as configured and trimmed, null when the remote is absent or git fails; a directory that is missing or blank rejects",
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
    id: 'update-install-disabled-env',
    files: ['packages/web/server/lib/opencode/openchamber-routes.js'],
    why: 'OPENCHAMBER_UPDATE_CHECK_DISABLED also makes the web update-install route answer that no update is available, before it asks the update service, installs or restarts',
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
    why: 'the server parses JSON bodies outside /api before plugin routes run, and needs no UI session there, so the Mittr shim and the MittrCraft tools callback get the engine request parsed',
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
    id: 'plugin-context-mcp-entity',
    files: ['packages/web/server/lib/opencode/config-v2.js', 'packages/web/server/index.js'],
    why: "the plugin context's opencode.mcpEntity is config-v2's toMcpEntity, unchanged: a v1 or v2 MCP entry becomes the v2 entry upstream writes (type local unless remote, enabled inverted into disabled, local command as strings, remote url, headers and snake_case oauth), so catalog connectors land in the engine's own shape without a copy of upstream's normaliser",
  },
  {
    id: 'mcp-user-layers',
    files: ['packages/web/server/lib/opencode/mcp.js', 'packages/web/server/lib/opencode/config-v2.js', 'packages/web/server/lib/opencode/shared.js'],
    why: "the person's own user config layers are opencode.json and opencode.jsonc under OPENCODE_CONFIG_DIR; Settings → MCP (listMcpConfigs) lists their v2 mcp.servers entries and their typed v1 mcp.<name> entries, so 1.22's mittr/<name> entries would still be listed and are swept; a catalog connector whose mittr-<name> one of those layers already holds is left out, since the engine deep-merges layers; upstream names a server only as ^[a-z0-9][a-z0-9_-]*[a-z0-9]$, which every mittr-<name> matches",
  },
  {
    id: 'managed-config-private',
    files: ['packages/web/server/lib/opencode/managed-config-file.js', 'packages/web/server/lib/opencode/shared.js'],
    why: "catalog connectors, keys included, live only in the managed config file: it is written mode 0600 through a temp file and a rename, handed to the engine child alone as OPENCODE_CONFIG, and never read by Settings → MCP, whose custom layer is the server's own OPENCODE_CONFIG; a person's own OPENCODE_CONFIG file and OPENCODE_CONFIG_CONTENT go to the engine beside it, so a mittr- name held there leaves ours out",
  },
  {
    id: 'plugin-context-control',
    files: [
      'packages/web/server/index.js',
      'packages/web/server/lib/openchamber-control/actions.js',
      'packages/web/server/lib/openchamber-control/service.js',
      'packages/web/server/lib/openchamber-control/screenshots.js',
      'packages/web/server/lib/openchamber-control/routes.js',
      'packages/web/server/lib/openchamber-control/error.js',
      'packages/web/server/lib/opencode/tunnel-auth.js',
    ],
    why: "the plugin context's control is the server's own control service, unchanged: execute(action, input, contextDirectory, { signal, contextSessionId }) and resolveSessionDirectory(sessionID), definitions() with the agent tool's control list and the web list, all with every action the service runs (memory, notify and the scheduler status among them), and writeScreenshot with SCREENSHOT_DIRECTORY (.openchamber/screenshots, a slug of the label and a stamp); no Mittr action takes an upstream action's name, and /api/mittr/control, behind the API auth, answers errors as upstream's control route does (status from statusCode or status, partial-result fields kept only from the control service's own OpenChamberControlError, the request's close aborting the action) and treats a request as local only when classifyRequestScope says local and the socket is loopback with no relay header",
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
    why: 'ModelPickerList takes isEntryBlocked and a blocked row is aria-disabled and chooses nothing on click, Enter or Space; ModelControls passes isEntryBlocked and composes renderRowEnd from the status pill of the picker decorations entryStatus and its own renderThinkingSlot; the mobile sheet row draws the same pill and disables its apply buttons (row, effort chips, more-efforts) for a blocked entry',
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
    id: 'integrations-page-slot',
    files: [
      'packages/ui/src/components/sections/integrations/IntegrationsPage.tsx',
      'packages/ui/src/lib/product-plugins.ts',
    ],
    why: 'the Integrations settings page renders the integrations-page slot once, inside its page layout right after the built-in integrations section and before the third-party integrations; Jira and Plane settings, then the Computer and Chrome tool settings, live there',
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
    id: 'engine-ripgrep-bin',
    files: ['packages/electron/package.json'],
    why: 'the bundled engine (OpenCode 2.0.22) runs the first rg on PATH, else <XDG_CACHE_HOME>/opencode/bin/rg, and only then downloads ripgrep 15.1.0 from github.com; engineEnv puts the app\'s bundled rg at that second place on every start, so the engine never downloads one',
  },
  {
    id: 'engine-skill-folders',
    files: ['packages/electron/package.json'],
    why: 'the bundled engine (OpenCode 2.0.22) reads skills from <config dir>/skills, scanning {*.md,**/SKILL.md} with dot folders included, and a SKILL.md takes its folder name as the skill id; catalog skills are written there as mittr-<name>/ and probe --only skills-mcp (scripts/mittr/probe-engine-v2.mjs) shows them listed within about 0.3 s with no restart, so a new engine version needs that probe run again',
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
    id: 'quota-provider-exclusive',
    files: ['packages/web/server/lib/quota/providers/registered.js', 'packages/web/server/lib/quota/providers/index.js'],
    why: "a quota provider registered with { exclusive: true } takes upstream's built-in providers out of the provider list and the dispatcher while it stays registered, so none of them reads another vendor's credential or calls that vendor; Mittr registers that way",
  },
  {
    id: 'quota-ui-registry',
    files: ['packages/ui/src/lib/quota/providers/index.ts'],
    why: "registerQuotaProvider adds a usage provider to the Usage page at run time, and with exclusive takes upstream's built-in providers off the list for good, and selectRegisteredQuotaProvider passes a registered id to the setter it is given, so the Usage page lists Mittr alone and opens on it",
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
    id: 'chat-message-product-hooks',
    files: ['packages/ui/src/components/chat/ChatMessage.tsx', 'packages/ui/src/lib/product-plugins.ts'],
    why: "an assistant message asks translateProductMessageError once, with its error's type, message, status and response body and the provider the turn ran on, before any of upstream's own error texts, and renders the assistant-message-footer slot once, under the assistant message body, with the message and whether its turn is the latest; the used-up quota text and Try again live there",
  },
  {
    id: 'session-store-send-message',
    files: ['packages/ui/src/sync/session-ui-store.ts', 'packages/ui/src/stores/types/sessionTypes.ts', 'packages/ui/src/lib/opencode/client.ts'],
    why: "useSessionUIStore.getState().sendMessage(content, providerID, modelID, agent, attachments, agentMentionName, additionalParts, variant, inputMode, { sessionId, directory }) sends to that session, takes attachments as AttachedFile (dataUrl, mimeType, filename), turns synthetic additional parts into context admitted before the prompt, switches the model and agent only when the session is not on them, and inserts the user message optimistically; Try again sends the refused turn again that way, as 1.22 did, so the refused turn stops being the latest at once",
  },
  {
    id: 'quota-retry-turn-read',
    files: ['packages/ui/src/sync/sync-refs.ts', 'packages/ui/src/sync/types.ts', 'packages/ui/src/lib/opencode/model.ts', 'packages/ui/src/sync/session-ui-store.ts'],
    why: "getSyncMessages(sessionId, directory) lists a session's messages in order (the synthetic context mixed with switch, system and skill records, then the asking user message, then its assistant replies), getSyncParts(messageId, directory) gives a user message's text, file and agent parts, and getDirectoryForSession names the session's directory; Try again rebuilds the refused turn from them",
  },
  {
    id: 'quota-retry-button-ui',
    files: ['packages/ui/src/components/ui/button.tsx', 'packages/ui/src/components/icon/sprite.ts'],
    why: 'Try again is drawn with the shared Button (variant outline, size xs) and the refresh and loader-4 icons',
  },
  {
    id: 'answered-by-notice-ui',
    files: ['packages/ui/src/components/icon/sprite.ts', 'packages/ui/src/lib/opencode/model.ts'],
    why: "the note under an answer from a backup agent is drawn with the arrow-left-right icon, and finds its message by the assistant message's providerID, modelID and time.created and time.completed",
  },
  {
    id: 'quota-store-dropdown-providers',
    files: [
      'packages/ui/src/stores/useQuotaStore.ts',
      'packages/ui/src/hooks/useTraySync.ts',
      'packages/ui/src/components/usage/usageGroups.ts',
      'packages/ui/src/components/sections/usage/UsagePage.tsx',
      'packages/ui/src/components/sections/usage/UsageSidebar.tsx',
      'packages/ui/src/components/layout/Header.tsx',
    ],
    why: "useQuotaStore starts dropdownProviderIds from the providers registered when the store is made, its loadSettings is a store field every caller reads from the store, and it sets a new dropdownProviderIds (the saved usageDropdownProviders that are still registered) only when the settings were read; the tray and the work-status panel list only those ids, and the Usage page saves them as usageDropdownProviders, so Mittr is added to a list saved before it existed, once, after a read",
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
  {
    id: 'ui-auth-provider-registry',
    files: ['packages/web/server/lib/ui-auth/ui-auth.js', 'packages/web/server/index.js'],
    why: 'a server plugin registers a sign-in provider through context.uiAuth.registerProvider; while one is registered a server without a UI password requires a UI session that only the provider issues, the session status lists providers and passwordEnabled, signing out revokes that session\'s URL tokens, sign out everywhere rotates the secret provider sessions are signed with, context.uiAuth.passwordEnabled says whether a UI password is set, and context.uiAuth.createClient(options) mints a client token (the remote clients store createClient: label, expiresAt, authMethod) that a desktop app presents as a bearer token; the store trims a label and cuts it at 80 UTF-16 units, so the desktop label is built to fit',
  },
  {
    id: 'server-cli-entry',
    files: ['packages/web/bin/cli.js', 'packages/web/bin/cli-entry.js', 'packages/web/bin/lib/cli-startup.js', 'packages/web/package.json', 'packages/web/bin/lib/cli-args.js', 'packages/web/server/lib/security/bind-host.js', 'packages/web/server/lib/server-plugins.js', 'packages/web/server/index.js'],
    why: 'the mittrcraft bin runs packages/web/bin/cli.js in its own process with argv[1] set to bin/openchamber.mjs, a file named openchamber that imports the bin, which cli.js takes as being run directly because its name is the expected bin name; the startup unit, the macOS wrapper and the Windows wrapper all run argv[1] as their entry, so every boot goes through the bin, after filling in what the launch left unset: OPENCHAMBER_SERVER_PLUGINS and OPENCHAMBER_DATA_DIR, OPENCHAMBER_UI_PASSWORD and OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN from their 1.22 names, every variable of bin/product-env.json (with the engine home, the engine config and the process registry under a data dir the caller set), and BUN_BINARY, all names upstream reads',
  },
  {
    id: 'session-auth-methods-slot',
    files: ['packages/ui/src/components/auth/SessionAuthGate.tsx', 'packages/ui/src/lib/product-plugins.ts'],
    why: "the session gate renders the session-auth-methods slot once, with isTunnelLocked, the runtime it is in and onSignedIn(clientToken?), after its password form and outside the tunnel check; onSignedIn applies the client token it is given (a desktop window keeps it for the host it is connected to), or asks POST /api/client-auth/clients for one, and then lets the person in, answering false when a desktop window cannot get a token or the window is no longer on the host the gate was drawn for (the finisher is bound to the host the gate rendered on, so a sign-in that ends after a host switch changes nothing); the password form (passkeys with it) is left out when the 401 session status says passwordEnabled is false; the gate keeps the trust-device choice in localStorage under TRUST_DEVICE_STORAGE_KEY, which the slot reads when the gate has no form to show it",
  },
  {
    id: 'session-auth-description',
    files: ['packages/ui/src/components/auth/SessionAuthGate.tsx', 'packages/ui/src/lib/product-plugins.ts'],
    why: "the line under the gate's title is the first answer of translateProductSessionAuthDescription({ passwordEnabled, runtime }) with the runtime the sign-in slot is given from the product plugins' sessionAuthDescription, else upstream's sessionAuth.locked.passwordDescription; the tunnel line is never replaced",
  },
  {
    id: 'desktop-runtime-detect',
    files: ['packages/ui/src/lib/desktop.ts', 'packages/ui/src/components/auth/SessionAuthGate.tsx'],
    why: "isDesktopShell() is true only in the Electron window, so the profile stays off the desktop app; the gate tells the sign-in slot its runtime: 'web', 'desktop-local' (the window runs its own server) or 'desktop-remote' (connected to another host, which it signs in to with a client token, since a cookie from the page is not sent to another site)",
  },
  {
    id: 'ad-sign-in-ui',
    files: [
      'packages/ui/src/components/ui/button.tsx',
      'packages/ui/src/components/ui/checkbox.tsx',
      'packages/ui/src/components/ui/input.tsx',
      'packages/ui/src/components/icon/sprite.ts',
      'packages/ui/src/lib/runtime-url.ts',
      'packages/ui/src/lib/runtime-fetch.ts',
    ],
    why: "the company sign-in is drawn with Button (outline, icon size), Input and Checkbox (checked, onChange, disabled, ariaLabel) and the user, lock, key and loader-4 icons; its Microsoft button goes to getRuntimeUrlResolver().auth(...) and its requests go through runtimeFetch, which sends /auth/ paths to the runtime's server",
  },
  {
    id: 'server-only-secrets',
    files: ['packages/web/server', 'packages/web/bin', 'packages/mittr-server/src/plugin.js'],
    why: "every secret-shaped OPENCHAMBER_ or OPENCODE_ variable, and NGROK_AUTHTOKEN, that upstream's server or CLI reads is either withheld from the engine (SERVER_ONLY_SECRETS in plugin.js) or one upstream means a child to have; a name upstream adds, renames or drops fails here; JIRA_TOKEN and PLANE_API_KEY are the platform's own names for the work tracking credentials and are withheld too",
    childSecrets: ['OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD', 'OPENCHAMBER_AGENT_TOOL_TOKEN', 'OPENCHAMBER_SERVICE_TOKEN', 'OPENCHAMBER_GIT_SSH_KEY'],
  },
  {
    id: 'login-shell-env-before-plugins',
    files: ['packages/web/server/index.js', 'packages/web/server/lib/opencode/env-runtime.js'],
    why: 'the server copies every login-shell variable that process.env lacks into process.env when index.js is imported, before plugins set up, so a variable set only in the login shell is in the environment the plugin takes company sign-in settings from',
  },
  {
    id: 'plugin-engine-env-withholds',
    files: ['packages/web/server/lib/server-plugins.js', 'packages/web/server/lib/opencode/lifecycle.js', 'packages/web/server/index.js'],
    why: 'a plugin engine variable set to undefined outranks the login shell snapshot and process.env on every engine start, version probe, install and upgrade, and is left out of the child environment',
  },
  {
    id: 'api-only-switch',
    files: ['packages/web/server/index.js', 'packages/web/server/lib/opencode/startup-pipeline-runtime.js', 'packages/web/server/lib/opencode/cli-options.js', 'packages/web/bin/lib/cli-args.js', 'packages/web/bin/lib/commands-serve.js'],
    why: 'API-only mode, which mounts the API-only fallback instead of the web build, is on exactly when the process got --api-only or OPENCHAMBER_API_ONLY is 1 or true, in the foreground server and the daemon alike',
  },
  {
    id: 'serve-runtime-switch',
    files: ['packages/web/bin/cli.js', 'packages/web/bin/lib/commands-serve.js'],
    why: 'the daemon server runs on BUN_BINARY when that answers --version, otherwise on the Node running the CLI, and gets its environment as an explicit copy of the CLI\'s',
  },
  {
    id: 'web-shell-after-plugins',
    files: ['packages/web/server/lib/opencode/static-routes-runtime.js', 'packages/web/server/lib/opencode/pwa-manifest-routes.js', 'packages/web/server/lib/opencode/startup-pipeline-runtime.js', 'packages/web/server/index.js'],
    why: 'the web build is served from OPENCHAMBER_DIST_DIR or packages/web/dist by express.static, every other app path gets res.sendFile of its index.html, the PWA manifest is res.send of its JSON, and all of it is mounted after server plugins set up',
  },
  {
    id: 'noindex',
    files: ['packages/web/server/index.js'],
    why: "hosted MittrCraft stays out of search engines through upstream's own header and robots.txt",
  },
  {
    id: 'projects-store',
    files: ['packages/ui/src/stores/useProjectsStore.ts', 'packages/ui/src/lib/api/types.ts'],
    why: 'My work lists the projects to start work in from useProjectsStore, whose projects each carry an id, a path and an optional label',
  },
  {
    id: 'open-external-url',
    files: ['packages/ui/src/lib/url.ts'],
    why: 'a My work card opens its Jira or Plane page through openExternalUrl(url), which answers a Promise<boolean> and opens only web addresses',
  },
  {
    id: 'my-work-panel-ui',
    files: [
      'packages/ui/src/components/ui/dialog.tsx',
      'packages/ui/src/components/ui/collapsible.tsx',
      'packages/ui/src/components/ui/input.tsx',
      'packages/ui/src/components/ui/button.tsx',
      'packages/ui/src/components/icon/sprite.ts',
      'packages/ui/src/lib/utils.ts',
    ],
    why: "the My work panel is a Dialog with a header, title and description; its state groups fold with Collapsible (defaultOpen, onOpenChange), its title filter is an Input, its source filters are chip Buttons pressed with aria-pressed, its actions are outline sm Buttons, it draws the briefcase, search, refresh, loader-4, error-warning, arrow-right-s, task, stack, play and folder icons, and it names a project without a label by formatDirectoryName(path)",
  },
  {
    id: 'session-create-selection',
    files: [
      'packages/ui/src/sync/session-actions.ts',
      'packages/ui/src/sync/session-ui-store.ts',
      'packages/ui/src/stores/useUIStore.ts',
    ],
    why: "Go work starts its session through createSession(title, directory, metadata, selectionTransition, selection, navigation), which creates the session on selection's model ({ providerID, id, variant }) and agent, opens it when navigation is 'open' and answers null when the create fails; the session is then set up with initializeNewOpenChamberSession(sessionId, agents), and closeMainSurfaces() brings the chat forward, as upstream does for a guest session it opens",
  },
  {
    id: 'work-tracking-settings-ui',
    files: [
      'packages/ui/src/components/sections/shared/SettingsSection.tsx',
      'packages/ui/src/components/ui/input.tsx',
      'packages/ui/src/components/ui/button.tsx',
      'packages/ui/src/components/ui/index.ts',
      'packages/ui/src/components/icon/sprite.ts',
      'packages/ui/src/lib/i18n/index.ts',
      'packages/ui/src/lib/i18n/messages/en.ts',
      'packages/ui/src/lib/i18n/messages/en.settings.ts',
    ],
    why: "Work tracking is a SettingsSection (title, info, contentClassName) holding SettingsStackedField cells (label, className) and a SettingsControlGroup (title, description, contentClassName), with SETTINGS_HELPER_CLASS for its quiet lines; its fields are Inputs that pass type, value and aria-label through, so the token and key are password fields, its actions are default, outline and ghost sm Buttons, results go to toast, it draws the loader-4, stack, close, add, checkbox-circle and error-warning icons, and it reads upstream's own common.loading and settings.common.actions.saveChanges through useI18n",
  },
  {
    id: 'guest-send-selection',
    files: [
      'packages/ui/src/lib/guests/start-session.ts',
      'packages/ui/src/stores/useConfigStore.ts',
      'packages/ui/src/sync/selection-store.ts',
      'packages/ui/src/lib/modelIdentifier.ts',
      'packages/ui/src/lib/modelVariants.ts',
    ],
    why: "Go work picks its model, agent and variant as upstream picks them for a session a guest starts; upstream keeps captureGuestSendSelection and its three resolvers private, so packages/mittr-ui/src/work/sendSelection.ts holds a copy, and the four bodies must match upstream's text, with the same imports, for as long as startGuestSession still uses that selection",
  },
  {
    id: 'agent-tool-settings-keys',
    files: [
      'packages/web/server/lib/opencode/settings-registry.json',
      'packages/web/server/lib/opencode/settings-helpers.js',
      'packages/web/server/lib/opencode/settings-runtime.js',
      'packages/web/server/lib/opencode/managed-config-file.js',
    ],
    why: "upstream's settings registry still has agentControlToolEnabled, agentWebToolEnabled and agentToolsCodeMode, kept as booleans; the control tool is on unless set false and Code Mode is off unless set true, as the managed config reads them, and a change of either rewrites the managed config, so the MittrCraft work tool follows the control switch and every MittrCraft tool follows Code Mode",
  },
  {
    id: 'managed-config-plugin-order',
    files: ['packages/web/server/lib/opencode/managed-config-file.js'],
    why: "the managed config lists upstream's own plugin folders, its agent tool among them, before the plugins a server plugin contributes, so the engine sets up the MittrCraft tools plugin after upstream's tools exist",
  },
  {
    id: 'session-idle-aborted-event',
    files: ['packages/web/server/lib/event-stream/translate-v2.js', 'packages/web/server/lib/event-stream/global-hub.js', 'packages/web/server/index.js'],
    why: "a turn the person interrupts reaches the plugin context's event stream as a translated session.idle with properties.aborted true and properties.sessionID, the same signal upstream's own agent tool aborts its in-flight actions on, so a cancelled turn stops its MittrCraft tool actions too",
  },
  {
    id: 'session-deleted-event',
    files: ['packages/web/server/lib/event-stream/translate-v2.js', 'packages/web/server/lib/event-stream/global-hub.js', 'packages/web/server/index.js'],
    why: "a deleted session reaches the plugin context's event stream as a translated session.deleted whose properties.info.id is the session's id, so the server closes that session's agent Chrome and forgets its site grants without the engine plugin posting anything",
  },
  {
    id: 'engine-tool-plugin-api',
    files: ['packages/electron/package.json'],
    why: "the bundled engine is OpenCode 2.0.22, whose plugin ctx.tool.transform takes tools.add({ name, description, options: { codemode }, input, execute }) with plain JSON Schema input, hands execute a context with sessionID and an abort signal, lets a later plugin replace upstream's openchamber_web execute through tools.get and tools.update, sends a tool result's { type: 'file', uri: 'data:<mime>;base64,…', mime, name } content part to the model as an image (directly and through Code Mode, with the default model input), and applies a rewritten plugin file without a restart; a new engine version needs probe P13 to P18 (scripts/mittr/probe-engine-v2.mjs --only agent-tools) run again before this pin moves",
  },
  {
    id: 'screenshot-directory',
    files: ['packages/web/server/lib/openchamber-control/screenshots.js'],
    why: "upstream's SCREENSHOT_DIRECTORY is .openchamber/screenshots, and writeScreenshot saves under it at the project-relative posix path it reports, with a .png, .jpg or .webp extension, so the MittrCraft tools read a capture back from the session's project (readCapture) at exactly that path, and save their own screenshots through the same writer",
  },
  {
    id: 'web-capture-result',
    files: [
      'packages/web/server/lib/openchamber-control/service.js',
      'packages/web/server/lib/agent-tool/runtime.js',
      'packages/web/server/lib/opencode/managed-config-file.js',
      'packages/web/server/lib/opencode/settings-runtime.js',
    ],
    why: "upstream's control service answers browser.capture with a project-relative path under SCREENSHOT_DIRECTORY and no image bytes, saved under the input's directory when one is given and the session's otherwise, and the agent tool's openchamber_web returns that envelope as text content; it is offered unless agentWebToolEnabled is false, a change of that switch rewrites the managed config, and the managed config lists upstream's agent tool plugin before the plugins a server plugin contributes, so openchamber_web exists when the MittrCraft tools plugin's transform runs (tools.get finds it); the MittrCraft tools plugin wraps openchamber_web while the switch is on and adds the saved image after upstream's text, only for a capture saved in the session's own project",
  },
  {
    id: 'permission-never-auto-answer',
    files: ['packages/web/server/lib/permission-auto-accept/runtime.js', 'packages/web/server/lib/server-plugins.js', 'packages/web/server/index.js'],
    why: "a server plugin's neverAutoAnswer(permission) reaches upstream's permission auto-accept runtime, which then holds a marked request for the person in auto and safety sessions alike (no reply is sent and the safety classifier is not asked), announces it as left for the user, and never reports it as answered automatically, so the Chrome site question always reaches the person",
  },
  {
    id: 'permission-event-shape',
    files: ['packages/web/server/lib/event-stream/translate-v2.js', 'packages/web/server/lib/event-stream/global-hub.js', 'node_modules/@opencode/schema/dist/permission.js'],
    why: "a hub event hands plugins the raw wire payload beside translated(); the raw permission.asked carries data { id, sessionID, action, resources, save, metadata }, and only the raw permission.replied carries data.reply (once, always or reject) with requestID and sessionID, while the translated replied event keeps only properties { sessionID, requestID }, so the server reads the Chrome site answer from the raw payload",
  },
  {
    id: 'engine-permission-api',
    files: ['packages/electron/package.json', 'node_modules/@opencode/client/package.json'],
    why: "the bundled engine is OpenCode 2.0.22, where POST /api/session/:id/permission with { id, action, resources, save, metadata, source } raises the engine's own permission card under the id the server minted (answering { data: { id, effect } }, and dropping message), POST /api/session/:id/permission/:requestID/reply takes { decision } and answers 204, GET /api/session/:id/permission lists that session's open requests, GET and DELETE /api/permission/saved(/:id) list and remove the rules an always answer saves, and a plugin's ctx.permission.hook('evaluate', fn) may turn the effect a project rule gave (allow) into ask; probe P15 and P16 (scripts/mittr/probe-engine-v2.mjs --only agent-tools) must run again before this pin moves",
  },
  {
    id: 'settings-section-primitives',
    files: [
      'packages/ui/src/components/sections/shared/SettingsSection.tsx',
      'packages/ui/src/components/ui/select.tsx',
      'packages/ui/src/components/ui/button.tsx',
      'packages/ui/src/components/ui/index.ts',
      'packages/ui/src/lib/i18n/messages/en.ts',
    ],
    why: "SettingsSection, SettingsCheckboxRow and SettingsFieldRow are still exported from components/sections/shared/SettingsSection, the section with its title (a string drawn as its h2), info (behind the info hint) and children, with the checkbox row's checked, onChange, label, description, ariaLabel and info and the field row's label and info; Select's SelectValue takes a render function of the chosen value, and Button keeps its ghost and outline variants and sm size, components/ui exports toast, and the English dictionary has common.loading; the MittrCraft tools section is built from them",
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
