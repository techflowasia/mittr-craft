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
    why: 'the desktop shell passes pluginHost (a safeStorage secret store and the deep-link register) to startWebUiServer, which hands it to plugins as context.host',
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
