import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export const TENANT = '11111111-2222-3333-4444-555555555555';
export const CLIENT_ID = 'client-app-id';
export const REDIRECT_URI = 'https://mittrcraft.example.test/auth/ad/callback';
export const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
export const NOW = 1_800_000_000_000;

export const ENTRA_ENV = {
  MITTR_AD_CLIENT_ID: CLIENT_ID,
  MITTR_AD_CLIENT_SECRET: 'entra-client-secret-value',
  MITTR_AD_TENANT_ID: TENANT,
  MITTR_AD_REDIRECT_URI: REDIRECT_URI,
};

export const LDAP_ENV = {
  MITTR_AD_ENABLED: 'true',
  MITTR_AD_URL: 'ldaps://directory.example.test',
  MITTR_AD_BIND_DN: 'CN=svc,DC=corp,DC=test',
  MITTR_AD_BIND_PASSWORD: 'service-account-secret',
  MITTR_AD_SEARCH_BASE: 'DC=corp,DC=test',
};

export const directoryEntry = (username, over = {}) => ({
  pojo: {
    objectName: `CN=${username},OU=Staff,DC=corp,DC=test`,
    attributes: [
      { type: 'sAMAccountName', values: [username] },
      { type: 'displayName', values: [over.displayName ?? 'Ada Lovelace'] },
      { type: 'mail', values: [`${username}@corp.test`] },
      { type: 'department', values: ['Engineering'] },
      { type: 'title', values: ['Analyst'] },
      { type: 'memberOf', values: ['CN=Builders,OU=Groups,DC=corp,DC=test'] },
    ],
  },
});

export const fakeDirectory = ({ users = {}, entries = [], connect = 'ok', hangOn = null } = {}) => {
  const clients = [];
  const createClient = (options) => {
    const client = new EventEmitter();
    client.options = options;
    client.binds = [];
    client.searches = [];
    client.closed = false;
    client.bind = (dn, password, callback) => {
      client.binds.push(dn);
      if (hangOn === 'bind') return;
      setImmediate(() => {
        if (users[dn] !== undefined && users[dn] === password && password !== '') return callback(null);
        const error = new Error('Invalid Credentials');
        error.name = 'InvalidCredentialsError';
        return callback(error);
      });
    };
    client.search = (base, searchOptions, callback) => {
      client.searches.push({ base, ...searchOptions });
      if (hangOn === 'search') return;
      setImmediate(() => {
        const response = new EventEmitter();
        callback(null, response);
        for (const entry of entries) response.emit('searchEntry', entry);
        response.emit('end');
      });
    };
    client.unbind = (callback) => {
      client.closed = true;
      setImmediate(() => callback?.());
    };
    client.destroy = () => {
      client.closed = true;
    };
    clients.push(client);
    setImmediate(() => {
      if (connect === 'ok') client.emit('connect');
      else if (connect === 'error') client.emit('connectError', new Error('connect ECONNREFUSED'));
    });
    return client;
  };
  return { createClient, clients };
};

export const fakeMicrosoft = ({ now = () => NOW } = {}) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'key-1';
  const calls = [];
  const state = { claims: {}, tokenStatus: 200, idToken: null, metadata: null, sign: null };

  const sign = (claims, { header = {}, key = privateKey } = {}) => {
    const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT', ...header })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
    return `${head}.${body}.${signature}`;
  };

  const baseClaims = (nonce) => {
    const seconds = Math.floor(now() / 1000);
    return {
      iss: ISSUER,
      aud: CLIENT_ID,
      tid: TENANT,
      sub: 'subject-1',
      oid: 'object-1',
      name: 'Ada Lovelace',
      preferred_username: 'ada@corp.test',
      nonce,
      iat: seconds - 10,
      nbf: seconds - 10,
      exp: seconds + 3600,
    };
  };

  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetchImpl = async (url, init = {}) => {
    const target = new URL(String(url));
    const call = { url: target.toString(), method: init.method ?? 'GET', redirect: init.redirect, body: init.body ? new URLSearchParams(String(init.body)) : null };
    calls.push(call);
    if (target.hostname !== 'login.microsoftonline.com') throw new Error(`unexpected host ${target.hostname}`);
    if (target.pathname.endsWith('/.well-known/openid-configuration')) {
      return json(state.metadata ?? {
        issuer: ISSUER,
        authorization_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
        token_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
        jwks_uri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`,
      });
    }
    if (target.pathname.endsWith('/discovery/v2.0/keys')) {
      return json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, use: 'sig' }] });
    }
    if (target.pathname.endsWith('/oauth2/v2.0/token')) {
      if (state.tokenStatus !== 200) return json({ error: 'invalid_grant' }, state.tokenStatus);
      const idToken = state.idToken ?? sign({ ...baseClaims(state.nonce), ...state.claims });
      return json({ id_token: idToken, token_type: 'Bearer' });
    }
    return json({}, 404);
  };

  return { fetchImpl, calls, state, sign, baseClaims, publicKey, privateKey };
};

export const recordingLogger = () => {
  const lines = [];
  const record = (...args) => lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  return { lines, log: record, warn: record, error: record, info: record };
};
