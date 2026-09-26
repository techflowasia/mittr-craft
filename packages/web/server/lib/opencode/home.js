import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where the engine keeps its configuration, credentials and state.
 *
 * MittrCraft used to write straight into the engine's own home —
 * `~/.config/opencode` and `~/.local/share/opencode` — which are the paths a
 * developer's separately installed `opencode` also uses. That is a collision
 * in both directions, and the dangerous direction is outward: MittrCraft
 * writes the Mittr session into `auth.json`, so a developer who also has
 * `opencode` installed could run any model on the Mittr grant from outside
 * MittrCraft entirely, with none of it reaching the audit trail. The inward
 * direction is milder but still wrong — it overwrote a provider block the
 * developer owns, leaving a `.mittrcraft.backup` behind each time.
 *
 * So the managed engine is given a home of its own. The mechanism is the
 * engine's: it derives its paths from the XDG base variables and appends
 * `opencode`, and upstream's own desktop build relocates it the same way
 * rather than sharing a home with a CLI install.
 *
 * `MITTRCRAFT_ENGINE_HOME` overrides the base, for tests and for anyone who
 * deliberately wants the old shared layout back.
 */

const APP_DIR = 'opencode';

const legacyBase = {
  config: path.join(os.homedir(), '.config'),
  data: path.join(os.homedir(), '.local', 'share'),
  state: path.join(os.homedir(), '.local', 'state'),
  cache: path.join(os.homedir(), '.cache'),
};

const ownedBase = () => {
  const override = String(process.env.MITTRCRAFT_ENGINE_HOME ?? '').trim();
  if (override) {
    const root = path.resolve(override);
    return { config: root, data: root, state: root, cache: root };
  }
  return {
    config: path.join(os.homedir(), '.config', 'mittrcraft', 'engine'),
    data: path.join(os.homedir(), '.local', 'share', 'mittrcraft', 'engine'),
    state: path.join(os.homedir(), '.local', 'state', 'mittrcraft', 'engine'),
    cache: path.join(os.homedir(), '.cache', 'mittrcraft', 'engine'),
  };
};

/** The engine's config directory: agents, commands, skills, `opencode.json`. */
export const engineConfigDir = () => path.join(ownedBase().config, APP_DIR);

/** The engine's data directory: `auth.json` and the session database. */
export const engineDataDir = () => path.join(ownedBase().data, APP_DIR);

/** The same directories under the shared layout this replaced. */
export const legacyEngineConfigDir = () => path.join(legacyBase.config, APP_DIR);
export const legacyEngineDataDir = () => path.join(legacyBase.data, APP_DIR);

/**
 * The XDG variables that put a spawned engine in the directories above.
 *
 * Every base is set, not just the two that hold credentials: leaving `state`
 * or `cache` pointing at the shared home would put half of one installation
 * inside another, which is the situation this exists to end.
 */
export const engineHomeEnv = () => {
  const base = ownedBase();
  return {
    XDG_CONFIG_HOME: base.config,
    XDG_DATA_HOME: base.data,
    XDG_STATE_HOME: base.state,
    XDG_CACHE_HOME: base.cache,
  };
};

/**
 * Carry an existing installation's sessions into the new home, once.
 *
 * Only the database. Credentials are deliberately left behind: the Mittr
 * session is rewritten from the stored session on every start, and copying a
 * developer's personal provider keys into a directory MittrCraft owns would
 * repeat the mistake this change exists to correct, in the other direction.
 *
 * Runs only when the new home has no database of its own, so it never
 * overwrites work and is safe to call on every start. A failure is logged and
 * swallowed: starting with an empty history is a far smaller harm than
 * refusing to start.
 */
export const migrateEngineHome = ({ fsImpl = fs, log = console } = {}) => {
  const target = engineDataDir();
  const source = legacyEngineDataDir();
  if (target === source) return { migrated: false, reason: 'same-directory' };

  let entries;
  try {
    entries = fsImpl.readdirSync(source);
  } catch {
    return { migrated: false, reason: 'no-previous-installation' };
  }

  const databases = entries.filter((name) => name.startsWith('opencode-') && name.includes('.db'));
  if (databases.length === 0) return { migrated: false, reason: 'nothing-to-carry' };

  try {
    fsImpl.mkdirSync(target, { recursive: true });
    const copied = [];
    for (const name of databases) {
      const destination = path.join(target, name);
      if (fsImpl.existsSync(destination)) continue;
      fsImpl.copyFileSync(path.join(source, name), destination);
      copied.push(name);
    }
    if (copied.length === 0) return { migrated: false, reason: 'already-present' };
    log.log?.(`[engine] carried ${copied.length} session database file(s) into ${target}`);
    return { migrated: true, copied };
  } catch (error) {
    log.warn?.('[engine] could not carry the previous session database:', error?.message ?? error);
    return { migrated: false, reason: 'copy-failed' };
  }
};
