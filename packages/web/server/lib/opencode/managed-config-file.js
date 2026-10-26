import { parse as parseJsonc } from 'jsonc-parser';

import { mergeEngineConfig } from '../server-plugins.js';
import { appendManagedPlugin } from './managed-plugin-config.js';

export const MANAGED_CONFIG_FILE_NAME = 'opencode.managed.json';

/**
 * Built-in OpenCode plugins OpenChamber switches off for its managed child.
 *
 * `opencode.browser` only works when OpenCode's own desktop app attaches a
 * browser to the session; OpenChamber does not implement that protocol, so its
 * tools always fail with `browser.disconnected` and agents conclude browsing is
 * unavailable instead of using `openchamber_web`. A project config that lists
 * `opencode.browser` still re-enables it, because that layer sits above ours.
 */
const DISABLED_BUILTIN_PLUGINS = ['-opencode.browser'];

/**
 * The managed OpenCode config layer.
 *
 * OpenCode 2 watches every config source it reads, including the file named by
 * the `OPENCODE_CONFIG` environment variable, and reloads its plugin list when
 * that file changes. Writing OpenChamber's own plugin entries into a file we
 * own therefore makes toggling a managed tool take effect in the running
 * process — where `OPENCODE_CONFIG_CONTENT` (an environment variable) could
 * only ever change across a restart.
 *
 * The file is OpenChamber-owned. It holds `plugins`: the built-in plugins
 * OpenChamber disables, then its own plugin directories, then any plugins a
 * server plugin contributes. A server plugin's config fragment
 * (`contributeConfig`, see `server-plugins.js`) supplies every other key. Its
 * ordinary keys sit above the user's global `opencode.json` and below their
 * project config, so they never shadow a project-level choice. Policies are the
 * exception: they outrank project config (see below).
 *
 * When the user's own environment already sets `OPENCODE_CONFIG`, that file is
 * theirs: OpenChamber does not hijack it and falls back to merging its plugins
 * into `OPENCODE_CONFIG_CONTENT`, which keeps the old restart requirement for
 * managed-tool toggles.
 *
 * A server plugin's fragment is the exception. OpenCode 2.0.22 lists
 * `experimental.policies` from `OPENCODE_CONFIG_CONTENT` first, then project
 * config, `OPENCODE_CONFIG`, global and well-known config, and lets the last
 * matching rule decide. A policy in `OPENCODE_CONFIG_CONTENT` therefore loses
 * to any project or user file, while one in `OPENCODE_CONFIG` outranks project
 * config. With a contribution, the managed file stays the `OPENCODE_CONFIG`
 * layer, and the user's own `OPENCODE_CONFIG` file, then their
 * `OPENCODE_CONFIG_CONTENT`, move into `OPENCODE_CONFIG_CONTENT`.
 * Their file is then read once per start, and `{file:…}` references in it
 * resolve from OpenCode's working directory. A contribution or a user config
 * that cannot be read fails the start rather than run OpenCode without it.
 *
 * @param {object} dependencies
 * @param {typeof import('node:fs/promises')} dependencies.fsPromises
 * @param {typeof import('node:path')} dependencies.path
 * @param {string} dependencies.dataDir OpenChamber data directory
 * @param {NodeJS.ProcessEnv} [dependencies.env] environment the managed child inherits
 * @param {object|null} [dependencies.agentToolRuntime]
 * @param {() => Promise<object|null>} dependencies.readSettings
 * @param {() => boolean} dependencies.isAgentMemoryAvailable
 * @param {() => object | Promise<object>} [dependencies.contributeConfig] config fragment server plugins add
 */
export const createManagedConfigRuntime = ({
  fsPromises,
  path,
  dataDir,
  env = process.env,
  agentToolRuntime = null,
  readSettings,
  isAgentMemoryAvailable,
  contributeConfig = async () => ({}),
}) => {
  const filePath = path.join(dataDir, MANAGED_CONFIG_FILE_NAME);

  /** The user owns `OPENCODE_CONFIG` when their environment already set it. */
  const ownsConfigFile = () => (env.OPENCODE_CONFIG ?? '').trim().length === 0;
  // Whether the running child reads the managed file: set by each start.
  let publishesConfigFile = ownsConfigFile();

  const parseUserConfig = (text, source) => {
    const errors = [];
    const parsed = text.trim() ? parseJsonc(text, errors, { allowTrailingComma: true }) : {};
    if (errors.length > 0 || parsed === null || parsed === undefined || Object.getPrototypeOf(parsed) !== Object.prototype) {
      throw new Error(`${source} must contain a valid JSON object before OpenChamber can move it under a server plugin's config`);
    }
    return parsed;
  };

  /** The user's `OPENCODE_CONFIG` file, then their `OPENCODE_CONFIG_CONTENT`, as one config. */
  const readUserConfig = async () => {
    const userFile = path.resolve(env.OPENCODE_CONFIG.trim());
    const fileText = await fsPromises.readFile(userFile, 'utf8').catch((error) => {
      if (error?.code === 'ENOENT') return '';
      throw error;
    });
    return mergeEngineConfig(
      parseUserConfig(fileText, `OPENCODE_CONFIG (${userFile})`),
      parseUserConfig(env.OPENCODE_CONFIG_CONTENT ?? '', 'OPENCODE_CONFIG_CONTENT'),
    );
  };

  const writeConfigFile = async (pluginDirectories, contributed) => {
    await fsPromises.mkdir(dataDir, { recursive: true });
    const config = {
      ...contributed,
      plugins: [...DISABLED_BUILTIN_PLUGINS, ...pluginDirectories, ...(contributed.plugins ?? [])],
    };
    const text = `${JSON.stringify(config, null, 2)}\n`;
    // Temp + rename: OpenCode reacts to the write immediately, and a partial
    // read would make it drop every managed plugin until the next change.
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fsPromises.writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
      await fsPromises.rename(tmp, filePath);
    } catch (error) {
      await fsPromises.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  };

  /**
   * Materialize the plugins the current settings ask for and return their
   * directories in load order. Directories exist on disk before the config
   * file names them.
   */
  const materializeEnabledPlugins = async () => {
    const settings = await Promise.resolve(readSettings()).catch(() => null);
    const includeControl = settings?.agentControlToolEnabled !== false;
    const includeWeb = settings?.agentWebToolEnabled !== false;
    const includeMemory = isAgentMemoryAvailable() && settings?.agentMemoryToolEnabled === true;
    const includeNotify = settings?.agentNotifyToolEnabled === true;
    const codeMode = settings?.agentToolsCodeMode === true;

    const directories = [];
    if (agentToolRuntime && (includeControl || includeWeb || includeMemory || includeNotify)) {
      directories.push(await agentToolRuntime.materializePlugin({ includeControl, includeWeb, includeMemory, includeNotify, codeMode }));
    }
    return directories;
  };

  /**
   * Environment for a managed OpenCode child: the callback URL and per-child
   * token are always present, so a tool enabled later in the session can still
   * call back without a restart.
   */
  const buildManagedChildEnv = async () => {
    const directories = await materializeEnabledPlugins();
    const childEnv = agentToolRuntime ? agentToolRuntime.createChildEnv() : {};
    const contributed = await contributeConfig();
    if (ownsConfigFile()) {
      await writeConfigFile(directories, contributed);
      publishesConfigFile = true;
      return { ...childEnv, OPENCODE_CONFIG: filePath };
    }
    if (Object.keys(contributed).length > 0) {
      const userConfig = await readUserConfig();
      await writeConfigFile(directories, contributed);
      publishesConfigFile = true;
      return { ...childEnv, OPENCODE_CONFIG: filePath, OPENCODE_CONFIG_CONTENT: JSON.stringify(userConfig) };
    }
    publishesConfigFile = false;
    let content = env.OPENCODE_CONFIG_CONTENT;
    for (const directory of [...DISABLED_BUILTIN_PLUGINS, ...directories]) {
      content = appendManagedPlugin(content, directory, 'managed plugin');
    }
    return { ...childEnv, OPENCODE_CONFIG_CONTENT: content };
  };

  /**
   * Rewrite the managed config file after a managed-plugin setting changed, so
   * the running OpenCode picks the new plugin list up. A no-op when the user
   * owns `OPENCODE_CONFIG` and no server plugin contributes; those installs
   * still need a restart.
   *
   * @returns {Promise<{updated: boolean, reason?: string}>}
   */
  const refreshManagedConfigFile = async () => {
    if (!publishesConfigFile) return { updated: false, reason: 'external-config' };
    await writeConfigFile(await materializeEnabledPlugins(), await contributeConfig());
    return { updated: true };
  };

  return {
    filePath,
    ownsConfigFile,
    buildManagedChildEnv,
    refreshManagedConfigFile,
  };
};
