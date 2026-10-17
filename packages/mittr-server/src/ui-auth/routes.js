import crypto from 'node:crypto';

import { createAdAuth, hasAdConfiguration } from './ad-auth.js';
import { createEntraAuth, hasEntraConfiguration } from './entra-auth.js';

export const PROVIDER_ID = 'ad';
export const TRANSACTION_COOKIE = 'oc_ad_transaction';
const CALLBACK_PATH = '/auth/ad/callback';
const BODY_LIMIT = '16kb';
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 10;
const RATE_LIMIT_LOCKOUT_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_KEYS = 10_000;
const VERIFY_FAILED_PAGE = 'Microsoft sign-in could not be verified. Return to MittrCraft and try again.';
const SIGN_IN_FAILED_PAGE = 'Microsoft sign-in failed. Return to MittrCraft and try again.';

export const selectCompanyAuth = (env, { ldap = {}, entra = {} } = {}) => {
  if (hasEntraConfiguration(env)) return createEntraAuth(env, entra);
  if (hasAdConfiguration(env)) return createAdAuth(env, ldap);
  return null;
};

const isSecureRequest = (req) => {
  if (req.secure) return true;
  const forwarded = req.headers['x-forwarded-proto'];
  return typeof forwarded === 'string' && forwarded.split(',')[0]?.trim().toLowerCase() === 'https';
};

const readCookie = (req, name) => {
  for (const segment of String(req.headers.cookie ?? '').split(';')) {
    const separator = segment.indexOf('=');
    if (separator < 0 || segment.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(segment.slice(separator + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
};

const transactionCookie = (req, value, maxAgeSeconds) => [
  `${TRANSACTION_COOKIE}=${value}`,
  `Path=${CALLBACK_PATH}`,
  'HttpOnly',
  'SameSite=Lax',
  `Max-Age=${maxAgeSeconds}`,
  ...(isSecureRequest(req) ? ['Secure'] : []),
].join('; ');

const appendSetCookie = (res, cookie) => {
  const existing = res.getHeader('Set-Cookie');
  if (existing === undefined) res.setHeader('Set-Cookie', cookie);
  else res.setHeader('Set-Cookie', [...(Array.isArray(existing) ? existing : [String(existing)]), cookie]);
};

const sameText = (left, right) => {
  const a = Buffer.from(String(left), 'utf8');
  const b = Buffer.from(String(right), 'utf8');
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
};

const queryText = (req, name) => (typeof req.query?.[name] === 'string' ? req.query[name] : '');

const resolveReturnTo = (req) => {
  const raw = queryText(req, 'returnTo').trim();
  if (!raw) return '/';
  try {
    const host = typeof req.headers.host === 'string' ? req.headers.host : '';
    if (!host) return '/';
    const origin = new URL(`${isSecureRequest(req) ? 'https' : 'http'}://${host}`).origin;
    const target = new URL(raw, origin);
    if (target.origin !== origin || target.username || target.password) return '/';
    return `${target.pathname}${target.search}`;
  } catch {
    return '/';
  }
};

const createLoginRateLimiter = (now) => {
  const records = new Map();
  const keyOf = (req) => (req.ip || req.socket?.remoteAddress || 'no-ip').replace(/^::ffff:/, '');
  return {
    check: (req) => {
      const record = records.get(keyOf(req));
      const timestamp = now();
      if (record?.lockedUntil > timestamp) return { allowed: false, retryAfter: Math.ceil((record.lockedUntil - timestamp) / 1000) };
      if (record && (record.lockedUntil || timestamp - record.firstAttempt > RATE_LIMIT_WINDOW_MS)) records.delete(keyOf(req));
      return { allowed: true };
    },
    fail: (req) => {
      const key = keyOf(req);
      const timestamp = now();
      const record = records.get(key);
      if (!record && records.size >= RATE_LIMIT_MAX_KEYS) records.delete(records.keys().next().value);
      const next = record ? { ...record, count: record.count + 1 } : { count: 1, firstAttempt: timestamp };
      if (next.count >= RATE_LIMIT_MAX_ATTEMPTS) next.lockedUntil = timestamp + RATE_LIMIT_LOCKOUT_MS;
      records.set(key, next);
    },
    clear: (req) => records.delete(keyOf(req)),
    reset: () => records.clear(),
  };
};

export const registerCompanySignIn = (context, {
  env = process.env,
  ldap = {},
  entra = {},
  logger = context.logger ?? console,
  now = () => Date.now(),
} = {}) => {
  const { app, express, requestScope } = context;
  const auth = selectCompanyAuth(env, { ldap: { logger, ...ldap }, entra });
  if (auth && !auth.enabled) {
    throw new Error(`Company sign-in is misconfigured (${auth.configurationError}); refusing to start without it`);
  }
  if (auth && typeof context.uiAuth?.registerProvider !== 'function') {
    throw new Error('Company sign-in is configured but this server cannot require a UI session; refusing to start without it');
  }
  const provider = auth ? context.uiAuth.registerProvider({ id: PROVIDER_ID }) : null;
  const limiter = createLoginRateLimiter(now);
  const parseBody = express.json({ limit: BODY_LIMIT });
  const isEntra = auth?.mode === 'entra';
  const isLdap = auth?.mode === 'ldap';

  const tunnelLocked = (req) => {
    const scope = typeof requestScope === 'function' ? requestScope(req) : 'unknown-public';
    return scope === 'tunnel' || scope === 'unknown-public';
  };
  const refuseTunnel = (message) => (req, res, next) => {
    if (!tunnelLocked(req)) return next();
    return res.status(403).json({ error: message, tunnelLocked: true });
  };

  app.get('/auth/ad/status', refuseTunnel('Company sign-in is disabled for tunnel scope'), (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      enabled: Boolean(auth),
      ...(auth ? { mode: auth.mode } : {}),
      passwordEnabled: context.uiAuth?.passwordEnabled?.() === true,
      tunnelLocked: false,
    });
  });

  app.get('/auth/ad/login', refuseTunnel('Microsoft login is disabled for tunnel scope'), async (req, res) => {
    if (!isEntra) return res.status(400).json({ error: 'Microsoft authentication not configured' });
    try {
      const trustDevice = queryText(req, 'trustDevice') === 'true' || queryText(req, 'trustDevice') === '1';
      const transaction = await auth.beginAuthorization({ trustDevice, returnTo: resolveReturnTo(req) });
      const maxAge = Math.max(1, Math.floor((transaction.expiresAt - now()) / 1000));
      res.setHeader('Cache-Control', 'no-store');
      appendSetCookie(res, transactionCookie(req, encodeURIComponent(transaction.state), maxAge));
      return res.redirect(302, transaction.authorizationUrl);
    } catch (error) {
      logger.warn('[mittr] could not start Microsoft sign-in:', error?.message ?? 'Error');
      return res.status(502).json({ error: 'Unable to start Microsoft sign-in' });
    }
  });

  app.get(CALLBACK_PATH, refuseTunnel('Microsoft login is disabled for tunnel scope'), async (req, res) => {
    if (!isEntra) return res.status(400).type('text/plain').send('Microsoft authentication is not configured');
    const state = queryText(req, 'state');
    const code = queryText(req, 'code');
    const expected = readCookie(req, TRANSACTION_COOKIE);
    appendSetCookie(res, transactionCookie(req, '', 0));
    res.setHeader('Cache-Control', 'no-store');
    if (queryText(req, 'error') || !state || !code || !sameText(expected, state)) {
      return res.status(400).type('text/plain').send(VERIFY_FAILED_PAGE);
    }
    try {
      const result = await auth.completeAuthorization({ code, state });
      await provider.issueSession(req, res, {
        trustDevice: result.trustDevice,
        claims: { authMethod: 'entra', profile: result.profile },
      });
      return res.redirect(302, result.returnTo || '/');
    } catch (error) {
      logger.warn('[mittr] Microsoft sign-in callback failed:', error?.message ?? 'Error');
      return res.status(401).type('text/plain').send(SIGN_IN_FAILED_PAGE);
    }
  });

  app.post('/auth/ad/session', refuseTunnel('AD login is disabled for tunnel scope'), parseBody, async (req, res) => {
    if (!auth) return res.status(400).json({ error: 'AD authentication not configured' });
    if (!isLdap) return res.status(400).json({ error: 'Use the Microsoft sign-in redirect' });
    const limit = limiter.check(req);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfter));
      return res.status(429).json({ error: 'Too many login attempts, please try again later', retryAfter: limit.retryAfter });
    }
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

    const result = await auth.authenticate(username, password);
    if (!result.ok) {
      limiter.fail(req);
      provider.clearSession(req, res);
      return res.status(401).json({ error: result.error || 'Invalid credentials' });
    }
    limiter.clear(req);
    await provider.issueSession(req, res, {
      trustDevice: req.body?.trustDevice === true,
      claims: { authMethod: 'ad', username, profile: result.profile },
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ authenticated: true, profile: result.profile });
  });

  app.get('/auth/ad/profile', refuseTunnel('AD profile is disabled for tunnel scope'), async (req, res) => {
    if (!auth) return res.status(400).json({ error: 'AD authentication not configured' });
    const claims = await provider.readClaims(req);
    if (!claims) return res.status(401).json({ error: 'Not authenticated' });
    res.setHeader('Cache-Control', 'no-store');
    if (claims.authMethod === 'entra' && claims.profile) return res.json({ profile: claims.profile });
    if (typeof claims.username !== 'string' || !claims.username) return res.status(400).json({ error: 'No username in session' });
    const profile = await auth.getProfile(claims.username);
    if (!profile) return res.status(404).json({ error: 'User profile not found' });
    return res.json({ profile });
  });

  if (provider) {
    app.delete('/auth/session', refuseTunnel('Sign-out is disabled for tunnel scope'), (req, res) => {
      provider.clearSession(req, res);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ authenticated: false });
    });
  }

  return {
    enabled: Boolean(auth),
    mode: auth?.mode ?? null,
    dispose: () => {
      provider?.unregister();
      auth?.dispose();
      limiter.reset();
    },
  };
};
