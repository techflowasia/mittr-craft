import crypto from 'node:crypto';

export const TRANSACTION_TTL_MS = 600_000;
const MAX_TRANSACTIONS = 1_000;
const HTTP_TIMEOUT_MS = 10_000;
const CLOCK_TOLERANCE_S = 5;
const KEY_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const MICROSOFT_HOST = 'login.microsoftonline.com';
const SCOPE = 'openid profile email';
const MULTI_TENANT_IDS = new Set(['common', 'organizations', 'consumers']);
const TENANT_ID = /^[a-zA-Z0-9.-]+$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISSUER = /^https:\/\/login\.microsoftonline\.com\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/v2\.0$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export const REQUIRED_ENV_KEYS = [
  'MITTR_AD_CLIENT_ID',
  'MITTR_AD_CLIENT_SECRET',
  'MITTR_AD_TENANT_ID',
  'MITTR_AD_REDIRECT_URI',
];

const readNonEmpty = (env, key) => (typeof env?.[key] === 'string' ? env[key].trim() : '');

const isLoopbackHostname = (hostname) => {
  const host = hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
};

const parseRedirectUri = (value) => {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.hash) return null;
    if (url.protocol !== 'https:' && !isLoopbackHostname(url.hostname)) return null;
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
  if (!TENANT_ID.test(tenantId)) {
    return { present: true, config: null, error: 'MITTR_AD_TENANT_ID has an invalid format' };
  }
  if (MULTI_TENANT_IDS.has(tenantId.toLowerCase())) {
    return { present: true, config: null, error: 'MITTR_AD_TENANT_ID must name one tenant, not a multi-tenant endpoint' };
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
      discoveryUrl: `https://${MICROSOFT_HOST}/${encodeURIComponent(tenantId)}/v2.0/.well-known/openid-configuration`,
    },
  };
};

export const hasEntraConfiguration = (env = process.env) => REQUIRED_ENV_KEYS.some((key) => Boolean(readNonEmpty(env, key)));

const isTrustedMicrosoftUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === MICROSOFT_HOST && !url.username && !url.password;
  } catch {
    return false;
  }
};

const parseMetadata = (payload, configuredTenant) => {
  if (!payload || typeof payload !== 'object') return null;
  const field = (name) => (typeof payload[name] === 'string' ? payload[name] : '');
  const metadata = {
    issuer: field('issuer'),
    authorizationEndpoint: field('authorization_endpoint'),
    tokenEndpoint: field('token_endpoint'),
    jwksUri: field('jwks_uri'),
  };
  if (!Object.values(metadata).every(isTrustedMicrosoftUrl)) return null;
  const tenant = metadata.issuer.match(ISSUER)?.[1]?.toLowerCase();
  if (!tenant) return null;
  if (GUID.test(configuredTenant) && configuredTenant.toLowerCase() !== tenant) return null;
  return { ...metadata, tenant };
};

const decodeSegment = (segment) => JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));

const sameText = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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

export const createEntraAuth = (env = process.env, {
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  randomBytes = crypto.randomBytes,
  maxTransactions = MAX_TRANSACTIONS,
} = {}) => {
  const parsed = readConfig(env);
  if (!parsed.config) {
    return {
      enabled: false,
      configurationPresent: parsed.present,
      mode: 'entra',
      ...(parsed.error ? { configurationError: parsed.error } : {}),
      getStatus: () => ({ enabled: false, mode: 'entra', ...(parsed.error ? { configurationError: parsed.error } : {}) }),
      dispose: () => {},
    };
  }

  const config = parsed.config;
  const transactions = new Map();
  let metadataPromise = null;
  let keys = new Map();
  let keysFetchedAt = null;

  const request = (url, init = {}) => fetchImpl(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });

  const sweepTransactions = () => {
    const timestamp = now();
    for (const [state, transaction] of transactions) {
      if (transaction.expiresAt <= timestamp) transactions.delete(state);
    }
    if (transactions.size >= maxTransactions) {
      const busy = new Error('Too many Microsoft sign-ins are in progress');
      busy.code = 'SIGN_IN_BUSY';
      throw busy;
    }
  };

  const getMetadata = () => {
    metadataPromise ??= (async () => {
      const response = await request(config.discoveryUrl, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Microsoft identity metadata request failed (${response.status})`);
      const metadata = parseMetadata(await response.json().catch(() => null), config.tenantId);
      if (!metadata) throw new Error('Microsoft identity metadata is invalid');
      return metadata;
    })().catch((error) => {
      metadataPromise = null;
      throw error;
    });
    return metadataPromise;
  };

  const refreshKeys = async (metadata) => {
    keysFetchedAt = now();
    const response = await request(metadata.jwksUri, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Microsoft signing keys request failed (${response.status})`);
    const payload = await response.json().catch(() => null);
    const next = new Map();
    for (const jwk of Array.isArray(payload?.keys) ? payload.keys : []) {
      if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string' || (jwk.use !== undefined && jwk.use !== 'sig')) continue;
      try {
        next.set(jwk.kid, crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' }));
      } catch {
        continue;
      }
    }
    keys = next;
  };

  const signingKey = async (metadata, kid) => {
    if (!keys.has(kid) && (keysFetchedAt === null || now() - keysFetchedAt >= KEY_REFRESH_INTERVAL_MS)) {
      await refreshKeys(metadata);
    }
    return keys.get(kid) ?? null;
  };

  const verifyIdToken = async (idToken, metadata, expectedNonce) => {
    const segments = typeof idToken === 'string' ? idToken.split('.') : [];
    if (segments.length !== 3 || !segments.every((segment) => BASE64URL.test(segment))) {
      throw new Error('Microsoft identity token is malformed');
    }
    let header;
    let claims;
    try {
      header = decodeSegment(segments[0]);
      claims = decodeSegment(segments[1]);
    } catch {
      throw new Error('Microsoft identity token is malformed');
    }
    if (header?.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit !== undefined) {
      throw new Error('Microsoft identity token uses an unexpected signature');
    }
    const key = await signingKey(metadata, header.kid);
    if (!key) throw new Error('Microsoft identity token is signed with an unknown key');
    const signed = Buffer.from(`${segments[0]}.${segments[1]}`, 'ascii');
    if (!crypto.verify('RSA-SHA256', signed, key, Buffer.from(segments[2], 'base64url'))) {
      throw new Error('Microsoft identity token signature is invalid');
    }
    if (!claims || typeof claims !== 'object') throw new Error('Microsoft identity token is malformed');

    const seconds = now() / 1000;
    if (claims.iss !== metadata.issuer) throw new Error('Microsoft identity token has the wrong issuer');
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(config.clientId)) throw new Error('Microsoft identity token has the wrong audience');
    if (audiences.length > 1 && claims.azp !== config.clientId) throw new Error('Microsoft identity token has the wrong audience');
    if (typeof claims.tid !== 'string' || claims.tid.toLowerCase() !== metadata.tenant) {
      throw new Error('Microsoft identity token is from another tenant');
    }
    if (typeof claims.exp !== 'number' || seconds > claims.exp + CLOCK_TOLERANCE_S) throw new Error('Microsoft identity token has expired');
    if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > seconds + CLOCK_TOLERANCE_S)) {
      throw new Error('Microsoft identity token is not valid yet');
    }
    if (typeof claims.iat !== 'number' || claims.iat > seconds + CLOCK_TOLERANCE_S) throw new Error('Microsoft identity token has a bad issue time');
    if (!sameText(claims.nonce, expectedNonce)) throw new Error('Microsoft identity nonce does not match');
    if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('Microsoft identity is missing a subject');
    return claims;
  };

  const beginAuthorization = async ({ trustDevice = false, returnTo = null } = {}) => {
    const metadata = await getMetadata();
    sweepTransactions();
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(64).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const expiresAt = now() + TRANSACTION_TTL_MS;
    transactions.set(state, {
      nonce,
      codeVerifier,
      trustDevice: trustDevice === true,
      returnTo: typeof returnTo === 'string' && returnTo ? returnTo : null,
      expiresAt,
    });

    const authorizationUrl = new URL(metadata.authorizationEndpoint);
    authorizationUrl.searchParams.set('client_id', config.clientId);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('redirect_uri', config.redirectUri);
    authorizationUrl.searchParams.set('response_mode', 'query');
    authorizationUrl.searchParams.set('scope', SCOPE);
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('nonce', nonce);
    authorizationUrl.searchParams.set('code_challenge', codeChallenge);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');
    return { authorizationUrl: authorizationUrl.toString(), state, expiresAt };
  };

  const completeAuthorization = async ({ code, state }) => {
    const transaction = typeof state === 'string' ? transactions.get(state) : undefined;
    if (transaction) transactions.delete(state);
    if (!transaction || transaction.expiresAt <= now()) throw new Error('Microsoft sign-in transaction is invalid or expired');
    if (typeof code !== 'string' || !code.trim()) throw new Error('Microsoft authorization code is missing');

    const metadata = await getMetadata();
    const response = await request(metadata.tokenEndpoint, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'authorization_code',
        code: code.trim(),
        redirect_uri: config.redirectUri,
        code_verifier: transaction.codeVerifier,
        scope: SCOPE,
      }).toString(),
    });
    const tokenPayload = await response.json().catch(() => null);
    if (!response.ok || typeof tokenPayload?.id_token !== 'string') {
      throw new Error(`Microsoft token exchange failed (${response.status})`);
    }
    const claims = await verifyIdToken(tokenPayload.id_token, metadata, transaction.nonce);
    return {
      profile: profileFromClaims(claims),
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
    cancelAuthorization: (state) => {
      transactions.delete(state);
    },
    getStatus: () => ({ enabled: true, mode: 'entra' }),
    dispose: () => transactions.clear(),
  };
};
