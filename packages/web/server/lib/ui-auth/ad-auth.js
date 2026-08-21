import ldap from 'ldapjs';
import { createEntraAuth, hasEntraConfiguration } from './entra-auth.js';

const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;

const readAdConfig = () => {
  const enabled = process.env.MITTR_AD_ENABLED === 'true';
  if (!enabled) return null;

  const url = process.env.MITTR_AD_URL;
  const bindDn = process.env.MITTR_AD_BIND_DN;
  const bindPassword = process.env.MITTR_AD_BIND_PASSWORD;
  const searchBase = process.env.MITTR_AD_SEARCH_BASE;

  if (!url || !bindDn || !bindPassword || !searchBase) {
    console.warn('[AD] Missing required configuration. Set MITTR_AD_URL, MITTR_AD_BIND_DN, MITTR_AD_BIND_PASSWORD, and MITTR_AD_SEARCH_BASE');
    return null;
  }

  return {
    url,
    bindDn,
    bindPassword,
    searchBase,
    userAttribute: 'sAMAccountName',
    displayNameAttr: 'displayName',
    emailAttr: 'mail',
    departmentAttr: 'department',
    titleAttr: 'title',
    memberOfAttr: 'memberOf',
  };
};

const profileCache = new Map();

const getCachedProfile = (username) => {
  const entry = profileCache.get(username);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > PROFILE_CACHE_TTL_MS) {
    profileCache.delete(username);
    return null;
  }
  return entry.profile;
};

const setCachedProfile = (username, profile) => {
  profileCache.set(username, { profile, timestamp: Date.now() });
};

const clearProfileCache = (username) => {
  if (username) {
    profileCache.delete(username);
  } else {
    profileCache.clear();
  }
};

const createLdapClient = (config) => {
  const client = ldap.createClient({
    url: config.url,
    tlsOptions: {
      rejectUnauthorized: false,
    },
    connectTimeout: 5000,
    timeout: 10000,
    idleTimeout: 10000,
  });

  client.on('error', (err) => {
    console.error('[AD] LDAP client error:', err.message);
  });

  return client;
};

const ldapBind = (client, bindDn, bindPassword) => {
  return new Promise((resolve, reject) => {
    client.bind(bindDn, bindPassword, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
};

const ldapSearch = (client, searchBase, options) => {
  return new Promise((resolve, reject) => {
    client.search(searchBase, options, (err, res) => {
      if (err) {
        reject(err);
        return;
      }

      const entries = [];
      res.on('searchEntry', (entry) => {
        entries.push(entry);
      });
      res.on('error', (err2) => {
        reject(err2);
      });
      res.on('end', () => {
        resolve(entries);
      });
    });
  });
};

const ldapUnbind = (client) => {
  return new Promise((resolve) => {
    client.unbind(() => {
      resolve();
    });
  });
};

const extractAttribute = (entry, attrName) => {
  const attr = entry.pojo?.attributes?.find((a) => a.type === attrName);
  if (!attr) return null;
  return Array.isArray(attr.values) ? attr.values[0] : attr.values;
};

const extractMultiAttribute = (entry, attrName) => {
  const attr = entry.pojo?.attributes?.find((a) => a.type === attrName);
  if (!attr) return [];
  return Array.isArray(attr.values) ? attr.values : [attr.values];
};

const buildUserProfile = (entry, config) => {
  return {
    username: extractAttribute(entry, config.userAttribute),
    displayName: extractAttribute(entry, config.displayNameAttr),
    email: extractAttribute(entry, config.emailAttr),
    department: extractAttribute(entry, config.departmentAttr),
    title: extractAttribute(entry, config.titleAttr),
    groups: extractMultiAttribute(entry, config.memberOfAttr).map((dn) => {
      const cnMatch = dn.match(/CN=([^,]+)/i);
      return cnMatch ? cnMatch[1] : dn;
    }),
  };
};

export const createAdAuth = () => {
  if (hasEntraConfiguration()) {
    return createEntraAuth();
  }

  const config = readAdConfig();

  if (!config) {
    return {
      enabled: false,
      authenticate: async () => ({ ok: false, error: 'AD authentication not configured' }),
      getProfile: async () => null,
      getStatus: () => ({ enabled: false }),
      dispose: () => {},
    };
  }

  const authenticate = async (username, password) => {
    if (!username || !password) {
      return { ok: false, error: 'Username and password are required' };
    }

    let client;
    try {
      client = createLdapClient(config);

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('LDAP connection timeout'));
        }, 5000);
        client.on('connect', () => {
          clearTimeout(timer);
          resolve();
        });
        client.on('connectError', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      const searchFilter = `(${config.userAttribute}=${username})`;
      const searchOptions = {
        filter: searchFilter,
        scope: 'sub',
        attributes: [
          config.userAttribute,
          config.displayNameAttr,
          config.emailAttr,
          config.departmentAttr,
          config.titleAttr,
          config.memberOfAttr,
        ],
      };

      const entries = await ldapSearch(client, config.searchBase, searchOptions);

      if (entries.length === 0) {
        await ldapUnbind(client);
        return { ok: false, error: 'User not found' };
      }

      const userEntry = entries[0];
      const userDn = userEntry.dn;

      await ldapBind(client, userDn.toString(), password);

      const profile = buildUserProfile(userEntry, config);
      setCachedProfile(username, profile);

      await ldapUnbind(client);

      return { ok: true, profile };
    } catch (err) {
      console.error('[AD] Authentication failed:', err.message);
      if (client) {
        try {
          await ldapUnbind(client);
        } catch {
          // ignore unbind errors
        }
      }

      if (err.name === 'InvalidCredentialsError') {
        return { ok: false, error: 'Invalid credentials' };
      }
      if (err.message === 'LDAP connection timeout') {
        return { ok: false, error: 'AD server connection timeout' };
      }
      return { ok: false, error: 'AD authentication failed' };
    }
  };

  const getProfile = async (username) => {
    const cached = getCachedProfile(username);
    if (cached) return cached;

    let client;
    try {
      client = createLdapClient(config);

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('LDAP connection timeout'));
        }, 5000);
        client.on('connect', () => {
          clearTimeout(timer);
          resolve();
        });
        client.on('connectError', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      await ldapBind(client, config.bindDn, config.bindPassword);

      const searchFilter = `(${config.userAttribute}=${username})`;
      const searchOptions = {
        filter: searchFilter,
        scope: 'sub',
        attributes: [
          config.userAttribute,
          config.displayNameAttr,
          config.emailAttr,
          config.departmentAttr,
          config.titleAttr,
          config.memberOfAttr,
        ],
      };

      const entries = await ldapSearch(client, config.searchBase, searchOptions);

      if (entries.length === 0) {
        await ldapUnbind(client);
        return null;
      }

      const profile = buildUserProfile(entries[0], config);
      setCachedProfile(username, profile);

      await ldapUnbind(client);

      return profile;
    } catch (err) {
      console.error('[AD] Failed to fetch profile:', err.message);
      if (client) {
        try {
          await ldapUnbind(client);
        } catch {
          // ignore
        }
      }
      return null;
    }
  };

  const getStatus = () => ({
    enabled: true,
    mode: 'ldap',
    url: config.url.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@'),
    searchBase: config.searchBase,
    userAttribute: config.userAttribute,
  });

  const dispose = () => {
    clearProfileCache();
  };

  return {
    enabled: true,
    authenticate,
    getProfile,
    getStatus,
    dispose,
  };
};
