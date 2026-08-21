import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const TRANSACTION_TTL_MS = 10 * 60 * 1000;
const REQUIRED_ENV_KEYS = [
  'MITTR_AD_CLIENT_ID',
  'MITTR_AD_CLIENT_SECRET',
  'MITTR_AD_TENANT_ID',
  'MITTR_AD_REDIRECT_URI',
];

const readNonEmpty = (env, key) => {
  const value = env?.[key];
  return typeof value === 'string' ? value.trim() : '';
};

const parseRedirectUri = (value) => {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.hash) {
      return null;
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (url.protocol !== 'https:' && !loopback) return null;
    return url.toString();
  } catch {
    return null;
  }
};

const readConfig = (env) => {
  const presentKeys = REQUIRED_ENV_KEYS.filter((key) => readNonEmpty(env, key));
  if (presentKeys.length === 0) return { present: false, config: null, error: null };
  if (presentKeys.length !== REQUIRED_ENV_KEYS.length) {
    const missing = REQUIRED_ENV_KEYS.filter((key) => !presentKeys.includes(key));
    return { present: true, config: null, error: `Missing ${missing.join(', ')}` };
  }

  const tenantId = readNonEmpty(env, 'MITTR_AD_TENANT_ID');
  if (!/^[a-zA-Z0-9.-]+$/.test(tenantId)) {
    return { present: true, config: null, error: 'MITTR_AD_TENANT_ID has an invalid format' };
  }

  const redirectUri = parseRedirectUri(readNonEmpty(env, 'MITTR_AD_REDIRECT_URI'));
  if (!redirectUri) {
    return { present: true, config: null, error: 'MITTR_AD_REDIRECT_URI must be HTTPS (HTTP is allowed only for loopback)' };
  }

  return {
    present: true,
    error: null,
    config: {
      clientId: readNonEmpty(env, 'MITTR_AD_CLIENT_ID'),
      clientSecret: readNonEmpty(env, 'MITTR_AD_CLIENT_SECRET'),
      tenantId,
      redirectUri,
      discoveryUrl: `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/v2.0/.well-known/openid-configuration`,
    },
  };
};

const isTrustedMicrosoftUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'login.microsoftonline.com';
  } catch {
    return false;
  }
};

const parseMetadata = (payload) => {
  if (!payload || typeof payload !== 'object') return null;
  const issuer = typeof payload.issuer === 'string' ? payload.issuer : '';
  const authorizationEndpoint = typeof payload.authorization_endpoint === 'string' ? payload.authorization_endpoint : '';
  const tokenEndpoint = typeof payload.token_endpoint === 'string' ? payload.token_endpoint : '';
  const jwksUri = typeof payload.jwks_uri === 'string' ? payload.jwks_uri : '';
  if (![issuer, authorizationEndpoint, tokenEndpoint, jwksUri].every(isTrustedMicrosoftUrl)) return null;
  return { issuer, authorizationEndpoint, tokenEndpoint, jwksUri };
};

const profileFromClaims = (claims) => ({
  id: typeof claims.oid === 'string' ? claims.oid : claims.sub,
  username: typeof claims.preferred_username === 'string' ? claims.preferred_username : null,
  displayName: typeof claims.name === 'string' ? claims.name : null,
  email: typeof claims.email === 'string'
    ? claims.email
    : (typeof claims.preferred_username === 'string' ? claims.preferred_username : null),
  tenantId: typeof claims.tid === 'string' ? claims.tid : null,
});

export const hasEntraConfiguration = (env = process.env) => {
  return REQUIRED_ENV_KEYS.some((key) => Boolean(readNonEmpty(env, key)));
};

export const createEntraAuth = ({
  env = process.env,
  fetchImpl = globalThis.fetch,
  createRemoteJWKSetImpl = createRemoteJWKSet,
  jwtVerifyImpl = jwtVerify,
  now = () => Date.now(),
  randomBytes = crypto.randomBytes,
} = {}) => {
  const parsed = readConfig(env);
  if (!parsed.config) {
    if (parsed.present) console.warn(`[Entra] Invalid configuration: ${parsed.error}`);
    return {
      enabled: false,
      configurationPresent: parsed.present,
      mode: 'entra',
      getStatus: () => ({ enabled: false, mode: 'entra', configurationError: parsed.error || undefined }),
      dispose: () => {},
    };
  }

  const config = parsed.config;
  const transactions = new Map();
  let metadataPromise = null;
  let remoteJwkSet = null;

  const sweepTransactions = () => {
    const timestamp = now();
    for (const [state, transaction] of transactions.entries()) {
      if (transaction.expiresAt <= timestamp) transactions.delete(state);
    }
  };

  const getMetadata = async () => {
    if (!metadataPromise) {
      metadataPromise = (async () => {
        const response = await fetchImpl(config.discoveryUrl, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`Microsoft identity metadata request failed (${response.status})`);
        const metadata = parseMetadata(await response.json());
        if (!metadata) throw new Error('Microsoft identity metadata is invalid');
        remoteJwkSet = createRemoteJWKSetImpl(new URL(metadata.jwksUri));
        return metadata;
      })().catch((error) => {
        metadataPromise = null;
        remoteJwkSet = null;
        throw error;
      });
    }
    return metadataPromise;
  };

  const beginAuthorization = async ({ trustDevice = false, returnTo = null } = {}) => {
    sweepTransactions();
    const metadata = await getMetadata();
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(64).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    transactions.set(state, {
      nonce,
      codeVerifier,
      trustDevice: trustDevice === true,
      returnTo: typeof returnTo === 'string' && returnTo ? returnTo : null,
      expiresAt: now() + TRANSACTION_TTL_MS,
    });

    const authorizationUrl = new URL(metadata.authorizationEndpoint);
    authorizationUrl.searchParams.set('client_id', config.clientId);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('redirect_uri', config.redirectUri);
    authorizationUrl.searchParams.set('response_mode', 'query');
    authorizationUrl.searchParams.set('scope', 'openid profile email');
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('nonce', nonce);
    authorizationUrl.searchParams.set('code_challenge', codeChallenge);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');
    return { authorizationUrl: authorizationUrl.toString(), state, expiresAt: now() + TRANSACTION_TTL_MS };
  };

  const completeAuthorization = async ({ code, state }) => {
    sweepTransactions();
    const transaction = transactions.get(state);
    if (!transaction) throw new Error('Microsoft sign-in transaction is invalid or expired');
    transactions.delete(state);
    if (typeof code !== 'string' || !code.trim()) throw new Error('Microsoft authorization code is missing');

    const metadata = await getMetadata();
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'authorization_code',
      code: code.trim(),
      redirect_uri: config.redirectUri,
      code_verifier: transaction.codeVerifier,
      scope: 'openid profile email',
    });
    const response = await fetchImpl(metadata.tokenEndpoint, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const tokenPayload = await response.json().catch(() => null);
    if (!response.ok || typeof tokenPayload?.id_token !== 'string') {
      throw new Error(`Microsoft token exchange failed (${response.status})`);
    }
    if (!remoteJwkSet) throw new Error('Microsoft signing keys are unavailable');

    const verified = await jwtVerifyImpl(tokenPayload.id_token, remoteJwkSet, {
      issuer: metadata.issuer,
      audience: config.clientId,
      algorithms: ['RS256'],
      clockTolerance: 5,
    });
    if (verified.payload.nonce !== transaction.nonce) throw new Error('Microsoft identity nonce does not match');
    if (typeof verified.payload.sub !== 'string' || !verified.payload.sub) throw new Error('Microsoft identity is missing a subject');

    return {
      profile: profileFromClaims(verified.payload),
      trustDevice: transaction.trustDevice,
      ...(transaction.returnTo ? { returnTo: transaction.returnTo } : {}),
    };
  };

  return {
    enabled: true,
    configurationPresent: true,
    mode: 'entra',
    beginAuthorization,
    completeAuthorization,
    getStatus: () => ({ enabled: true, mode: 'entra', loginPath: '/auth/ad/login' }),
    dispose: () => transactions.clear(),
  };
};
