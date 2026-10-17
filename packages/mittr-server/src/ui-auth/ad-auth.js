import ldap from 'ldapjs';

const REQUIRED_ENV_KEYS = ['MITTR_AD_URL', 'MITTR_AD_BIND_DN', 'MITTR_AD_BIND_PASSWORD', 'MITTR_AD_SEARCH_BASE'];
const CONNECT_TIMEOUT_MS = 5_000;
const OPERATION_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 1_000;
const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_USERNAME_LENGTH = 256;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

const ATTRIBUTES = {
  username: 'sAMAccountName',
  displayName: 'displayName',
  email: 'mail',
  department: 'department',
  title: 'title',
  groups: 'memberOf',
};

const readNonEmpty = (env, key) => (typeof env?.[key] === 'string' ? env[key].trim() : '');

export const escapeLdapFilterValue = (value) => String(value).replace(
  /[\\*()\u0000]/g,
  (character) => `\\${character.charCodeAt(0).toString(16).padStart(2, '0')}`,
);

const parseDirectoryUrl = (value) => {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'ldap:' && url.protocol !== 'ldaps:') || url.username || url.password) return null;
    return value;
  } catch {
    return null;
  }
};

const readAdConfig = (env) => {
  if (readNonEmpty(env, 'MITTR_AD_ENABLED') !== 'true') return { present: false, config: null, error: null };
  const missing = REQUIRED_ENV_KEYS.filter((key) => !readNonEmpty(env, key));
  if (missing.length > 0) return { present: true, config: null, error: `Missing ${missing.join(', ')}` };
  const url = parseDirectoryUrl(readNonEmpty(env, 'MITTR_AD_URL'));
  if (!url) return { present: true, config: null, error: 'MITTR_AD_URL must be an ldap:// or ldaps:// URL without credentials' };
  return {
    present: true,
    error: null,
    config: {
      url,
      bindDn: readNonEmpty(env, 'MITTR_AD_BIND_DN'),
      bindPassword: env.MITTR_AD_BIND_PASSWORD,
      searchBase: readNonEmpty(env, 'MITTR_AD_SEARCH_BASE'),
    },
  };
};

export const hasAdConfiguration = (env = process.env) => readAdConfig(env).present;

const normalizeUsername = (value) => {
  if (typeof value !== 'string') return '';
  const username = value.normalize('NFC').trim();
  if (!username || username.length > MAX_USERNAME_LENGTH || CONTROL_CHARACTER.test(username)) return '';
  return username;
};

const attributeValues = (entry, name) => {
  const attributes = entry?.pojo?.attributes ?? entry?.attributes ?? [];
  const attribute = attributes.find((candidate) => String(candidate?.type).toLowerCase() === name.toLowerCase());
  if (!attribute) return [];
  const values = attribute.values ?? attribute.vals ?? [];
  return (Array.isArray(values) ? values : [values]).map((value) => String(value));
};

const firstValue = (entry, name) => attributeValues(entry, name)[0] ?? null;

const entryDn = (entry) => {
  const dn = entry?.pojo?.objectName ?? entry?.objectName ?? entry?.dn;
  return dn ? String(dn) : '';
};

const groupName = (dn) => dn.match(/^\s*CN=((?:\\.|[^,])+)/i)?.[1] ?? dn;

const buildProfile = (entry) => ({
  username: firstValue(entry, ATTRIBUTES.username),
  displayName: firstValue(entry, ATTRIBUTES.displayName),
  email: firstValue(entry, ATTRIBUTES.email),
  department: firstValue(entry, ATTRIBUTES.department),
  title: firstValue(entry, ATTRIBUTES.title),
  groups: attributeValues(entry, ATTRIBUTES.groups).map(groupName),
});

class DirectoryTimeout extends Error {
  constructor() {
    super('Directory request timed out');
    this.name = 'DirectoryTimeout';
  }
}

const withTimeout = (timeoutMs, start) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new DirectoryTimeout()), timeoutMs);
  start(
    (value) => {
      clearTimeout(timer);
      resolve(value);
    },
    (error) => {
      clearTimeout(timer);
      reject(error);
    },
  );
});

const disabledAuth = (parsed) => ({
  enabled: false,
  configurationPresent: parsed.present,
  mode: 'ldap',
  ...(parsed.error ? { configurationError: parsed.error } : {}),
  getStatus: () => ({ enabled: false, ...(parsed.present ? { mode: 'ldap' } : {}), ...(parsed.error ? { configurationError: parsed.error } : {}) }),
  authenticate: async () => ({ ok: false, error: 'AD authentication not configured' }),
  getProfile: async () => null,
  dispose: () => {},
});

export const createAdAuth = (env = process.env, {
  createClient = ldap.createClient,
  logger = console,
  now = () => Date.now(),
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  timeoutMs = OPERATION_TIMEOUT_MS,
} = {}) => {
  const parsed = readAdConfig(env);
  if (!parsed.config) return disabledAuth(parsed);
  const config = parsed.config;
  const profiles = new Map();

  if (config.url.startsWith('ldap:')) {
    logger.warn('[mittr] the company directory is reached over ldap://, so sign-in passwords cross the network unencrypted; use ldaps://');
  }

  const closeClient = (client) => new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client.destroy?.();
      } catch {
        logger.warn('[mittr] could not close the directory connection');
      }
      resolve();
    };
    const timer = setTimeout(finish, CLOSE_TIMEOUT_MS);
    try {
      client.unbind(finish);
    } catch {
      finish();
    }
  });

  const withClient = async (work) => {
    const client = createClient({
      url: config.url,
      connectTimeout: connectTimeoutMs,
      timeout: timeoutMs,
      tlsOptions: { minVersion: 'TLSv1.2' },
    });
    client.on('error', (error) => {
      logger.warn('[mittr] directory connection error:', error?.name ?? 'Error');
    });
    try {
      await withTimeout(connectTimeoutMs, (resolve, reject) => {
        client.once('connect', () => resolve());
        client.once('connectError', reject);
        client.once('connectTimeout', reject);
      });
      return await work(client);
    } finally {
      await closeClient(client);
    }
  };

  const bind = (client, dn, password) => withTimeout(timeoutMs, (resolve, reject) => {
    client.bind(dn, password, (error) => (error ? reject(error) : resolve()));
  });

  const findUser = (client, username) => withTimeout(timeoutMs, (resolve, reject) => {
    const options = {
      filter: `(${ATTRIBUTES.username}=${escapeLdapFilterValue(username)})`,
      scope: 'sub',
      sizeLimit: 2,
      attributes: Object.values(ATTRIBUTES),
    };
    client.search(config.searchBase, options, (error, response) => {
      if (error) {
        reject(error);
        return;
      }
      const entries = [];
      response.on('searchEntry', (entry) => entries.push(entry));
      response.on('error', reject);
      response.on('end', () => resolve(entries));
    });
  });

  const bindServiceAccount = async (client) => {
    try {
      await bind(client, config.bindDn, config.bindPassword);
    } catch (error) {
      const failure = new Error('The directory service account could not sign in');
      failure.name = error?.name === 'DirectoryTimeout' ? 'DirectoryTimeout' : 'ServiceBindError';
      throw failure;
    }
  };

  const cacheProfile = (username, profile) => {
    profiles.set(username.toLowerCase(), { profile, expiresAt: now() + PROFILE_CACHE_TTL_MS });
  };

  const authenticate = async (rawUsername, password) => {
    const username = normalizeUsername(rawUsername);
    if (!username || typeof password !== 'string' || password.length === 0) {
      return { ok: false, error: 'Username and password are required' };
    }
    try {
      return await withClient(async (client) => {
        await bindServiceAccount(client);
        const entries = await findUser(client, username);
        const dn = entries.length === 1 ? entryDn(entries[0]) : '';
        if (!dn) return { ok: false, error: 'Invalid credentials' };
        try {
          await bind(client, dn, password);
        } catch (error) {
          if (error?.name === 'InvalidCredentialsError') return { ok: false, error: 'Invalid credentials' };
          throw error;
        }
        const profile = buildProfile(entries[0]);
        cacheProfile(username, profile);
        return { ok: true, profile };
      });
    } catch (error) {
      logger.warn('[mittr] directory sign-in failed:', error?.name ?? 'Error');
      if (error?.name === 'DirectoryTimeout' || error?.name === 'ConnectionError') {
        return { ok: false, error: 'AD server connection timeout' };
      }
      return { ok: false, error: 'AD authentication failed' };
    }
  };

  const getProfile = async (rawUsername) => {
    const username = normalizeUsername(rawUsername);
    if (!username) return null;
    const cached = profiles.get(username.toLowerCase());
    if (cached && cached.expiresAt > now()) return cached.profile;
    profiles.delete(username.toLowerCase());
    try {
      return await withClient(async (client) => {
        await bindServiceAccount(client);
        const entries = await findUser(client, username);
        if (entries.length !== 1) return null;
        const profile = buildProfile(entries[0]);
        cacheProfile(username, profile);
        return profile;
      });
    } catch (error) {
      logger.warn('[mittr] could not read the directory profile:', error?.name ?? 'Error');
      return null;
    }
  };

  return {
    enabled: true,
    configurationPresent: true,
    mode: 'ldap',
    authenticate,
    getProfile,
    getStatus: () => ({ enabled: true, mode: 'ldap' }),
    dispose: () => profiles.clear(),
  };
};
