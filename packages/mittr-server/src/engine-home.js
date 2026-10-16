import fs from 'node:fs';
import path from 'node:path';

/**
 * Where the managed engine keeps its configuration, credentials, sessions and
 * caches: the same folders MittrCraft 1.x used, so every install keeps its
 * history across the move to OpenCode 2.
 *
 * The engine derives its paths from the four XDG base variables and appends
 * `opencode`. MittrCraft never shares those bases with a separately installed
 * `opencode`: the Mittr grant in its credentials must not be usable from
 * outside the app, and a developer's own provider setup must not be
 * overwritten. `MITTRCRAFT_ENGINE_HOME` puts all four bases on one root; the
 * Dev build uses it.
 */

const ACCOUNT_HOME = /^[0-9a-f]{16}$/;

/**
 * How OpenCode 2 picks up a 1.x database. It opens
 * `<XDG_DATA_HOME>/opencode/opencode.db` and migrates it in place, which is the
 * file 1.x wrote. Naming it explicitly keeps a shell's own `OPENCODE_DB` from
 * pointing the engine at another file. Proven on copies of real installs in
 * `docs/plans/2026-10-16-phase-1-session-proof.md`.
 */
export const ENGINE_DB_RULE = Object.freeze({ opencodeDb: 'opencode.db' });

/** The four shared bases, before any account. */
export const engineBases = ({ homeDir, env }) => {
  const override = String(env.MITTRCRAFT_ENGINE_HOME ?? '').trim();
  if (override) {
    const root = path.resolve(override);
    return { config: root, data: root, state: root, cache: root };
  }
  return {
    config: path.join(homeDir, '.config', 'mittrcraft', 'engine'),
    data: path.join(homeDir, '.local', 'share', 'mittrcraft', 'engine'),
    state: path.join(homeDir, '.local', 'state', 'mittrcraft', 'engine'),
    cache: path.join(homeDir, '.cache', 'mittrcraft', 'engine'),
  };
};

/**
 * The folder the engine reads its user config from. It inherits
 * `OPENCODE_CONFIG_DIR` from the server; without it, OpenCode 2 uses
 * `<XDG_CONFIG_HOME>/opencode`, and `engineEnv` sets that base for it.
 */
export const engineConfigDir = ({ bases, env }) => {
  const own = String(env.OPENCODE_CONFIG_DIR ?? '').trim();
  return own ? path.resolve(own) : path.join(bases.config, 'opencode');
};

/**
 * The variables that put the engine in those folders. Every base is set, not
 * only the ones holding credentials, so no part of the engine lands in a
 * personal OpenCode home. A second account keeps its data and state under
 * `accounts/<home>`; configuration and caches stay shared, as in 1.x.
 */
export const engineEnv = ({ bases, accountHome, rule }) => {
  if (accountHome !== null && !ACCOUNT_HOME.test(String(accountHome))) {
    throw new Error('An engine account home must be an account key');
  }
  const own = (base) => (accountHome ? path.join(base, 'accounts', accountHome) : base);
  const env = {
    XDG_CONFIG_HOME: bases.config,
    XDG_DATA_HOME: own(bases.data),
    XDG_STATE_HOME: own(bases.state),
    XDG_CACHE_HOME: bases.cache,
  };
  if (rule.opencodeDb) env.OPENCODE_DB = rule.opencodeDb;
  return env;
};

const SESSION_DATABASE = /^opencode.*\.db$/;

const holdsSessionDatabase = (dir) => {
  try {
    return fs.readdirSync(dir).some((name) => SESSION_DATABASE.test(name));
  } catch {
    return false;
  }
};

/**
 * Whether the shared engine folders already hold a session database: the
 * history the first account of 1.x kept. Account homes under `accounts/` do
 * not count.
 */
export const sharedHistoryExists = (bases) => holdsSessionDatabase(bases.data) || holdsSessionDatabase(path.join(bases.data, 'opencode'));
