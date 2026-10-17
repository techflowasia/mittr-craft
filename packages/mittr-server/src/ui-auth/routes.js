import crypto from 'node:crypto';

import { createAdAuth, hasAdConfiguration } from './ad-auth.js';
import { TRANSACTION_TTL_MS, createEntraAuth, hasEntraConfiguration } from './entra-auth.js';

export const PROVIDER_ID = 'ad';
export const TRANSACTION_COOKIE = 'oc_ad_transaction';
const CALLBACK_PATH = '/auth/ad/callback';
const BODY_LIMIT = '16kb';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const TRUSTED_DEVICE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLIENT_LABEL = 'MittrCraft Desktop';
const CLIENT_LABEL_USERNAME_MAX = 56;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 10;
const RATE_LIMIT_LOCKOUT_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_KEYS = 10_000;
const LOGIN_STARTS_PER_IP = 20;
const LOGIN_STARTS_PER_WINDOW = 60;
const VERIFY_FAILED_PAGE = 'Microsoft sign-in could not be verified. Return to MittrCraft and try again.';
const SIGN_IN_FAILED_PAGE = 'Microsoft sign-in failed. Return to MittrCraft and try again.';

export const clientLabelFor = (username) => {
  const shown = Array.from(String(username).replace(/\p{Cc}/gu, '')).slice(0, CLIENT_LABEL_USERNAME_MAX).join('');
  return `${CLIENT_LABEL} (${shown})`;
};

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
    if (/^[\\/]{2}/.test(target.pathname) || /^[\\/]{2}/.test(decodeURIComponent(target.pathname))) return '/';
    return `${target.pathname}${target.search}`;
  } catch {
    return '/';
  }
};

const clientKey = (req) => (req.ip || req.socket?.remoteAddress || 'no-ip').replace(/^::ffff:/, '');

const createLoginStartLimiter = (now) => {
  const clients = new Map();
  const clientByState = new Map();
  let nextSlot = 0;

  const sweep = (key) => {
    const client = clients.get(key);
    if (!client) return null;
    const timestamp = now();
    for (const [slot, expiresAt] of client.pending) {
      if (expiresAt <= timestamp) {
        client.pending.delete(slot);
        clientByState.delete(slot);
      }
    }
    client.starts = client.starts.filter((at) => timestamp - at < TRANSACTION_TTL_MS);
    if (client.pending.size === 0 && client.starts.length === 0) {
      clients.delete(key);
      return null;
    }
    return client;
  };

  const releaseSlot = (key, slot) => {
    const client = clients.get(key);
    client?.pending.delete(slot);
    if (client && client.pending.size === 0 && client.starts.length === 0) clients.delete(key);
  };

  return {
    reserve: (req) => {
      const key = clientKey(req);
      const timestamp = now();
      const client = sweep(key);
      if (client && client.pending.size >= LOGIN_STARTS_PER_IP) {
        return { allowed: false, retryAfter: Math.max(1, Math.ceil((Math.min(...client.pending.values()) - timestamp) / 1000)) };
      }
      if (client && client.starts.length >= LOGIN_STARTS_PER_WINDOW) {
        return { allowed: false, retryAfter: Math.max(1, Math.ceil((client.starts[0] + TRANSACTION_TTL_MS - timestamp) / 1000)) };
      }
      if (!client && clients.size >= RATE_LIMIT_MAX_KEYS) {
        const [oldest, evicted] = clients.entries().next().value;
        for (const slot of evicted.pending.keys()) clientByState.delete(slot);
        clients.delete(oldest);
      }
      const entry = client ?? { pending: new Map(), starts: [] };
      const slot = `slot:${nextSlot += 1}`;
      entry.pending.set(slot, timestamp + TRANSACTION_TTL_MS);
      entry.starts.push(timestamp);
      clients.set(key, entry);
      return {
        allowed: true,
        hold: (state, expiresAt) => {
          const current = clients.get(key);
          if (!current?.pending.delete(slot)) return;
          current.pending.set(state, expiresAt);
          clientByState.set(state, key);
        },
        cancel: () => releaseSlot(key, slot),
      };
    },
    release: (state) => {
      const key = clientByState.get(state);
      if (key === undefined) return;
      clientByState.delete(state);
      releaseSlot(key, state);
    },
    reset: () => {
      clients.clear();
      clientByState.clear();
    },
  };
};

const createLoginRateLimiter = (now) => {
  const records = new Map();
  const keyOf = clientKey;
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
  const loginStarts = createLoginStartLimiter(now);
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
    const start = loginStarts.reserve(req);
    if (!start.allowed) {
      res.setHeader('Retry-After', String(start.retryAfter));
      return res.status(429).json({ error: 'Too many sign-in attempts, please try again later', retryAfter: start.retryAfter });
    }
    try {
      const trustDevice = queryText(req, 'trustDevice') === 'true' || queryText(req, 'trustDevice') === '1';
      let transaction;
      try {
        transaction = await auth.beginAuthorization({ trustDevice, returnTo: resolveReturnTo(req) });
      } catch (error) {
        start.cancel();
        throw error;
      }
      start.hold(transaction.state, transaction.expiresAt);
      const maxAge = Math.max(1, Math.floor((transaction.expiresAt - now()) / 1000));
      res.setHeader('Cache-Control', 'no-store');
      appendSetCookie(res, transactionCookie(req, encodeURIComponent(transaction.state), maxAge));
      return res.redirect(302, transaction.authorizationUrl);
    } catch (error) {
      logger.warn('[mittr] could not start Microsoft sign-in:', error?.message ?? 'Error');
      if (error?.code === 'SIGN_IN_BUSY') return res.status(429).json({ error: 'Too many sign-ins in progress, please try again later' });
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
    const ownState = Boolean(state) && sameText(expected, state);
    if (ownState) loginStarts.release(state);
    if (queryText(req, 'error') || !code || !ownState) {
      if (ownState) auth.cancelAuthorization(state);
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

  const mintClientToken = async (username, trustDevice) => {
    if (typeof context.uiAuth?.createClient !== 'function') return null;
    try {
      const minted = await context.uiAuth.createClient({
        label: clientLabelFor(username),
        expiresAt: new Date(now() + (trustDevice ? TRUSTED_DEVICE_SESSION_TTL_MS : SESSION_TTL_MS)).toISOString(),
        authMethod: 'ad',
      });
      return minted?.token ? minted : null;
    } catch (error) {
      logger.warn('[mittr] could not issue a client token:', error?.message ?? 'Error');
      return null;
    }
  };

  app.post('/auth/ad/session', refuseTunnel('AD login is disabled for tunnel scope'), parseBody, async (req, res) => {
    if (!auth) return res.status(400).json({ error: 'AD authentication not configured', code: 'not-configured' });
    if (!isLdap) return res.status(400).json({ error: 'Use the Microsoft sign-in redirect', code: 'use-microsoft' });
    const limit = limiter.check(req);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfter));
      return res.status(429).json({ error: 'Too many login attempts, please try again later', retryAfter: limit.retryAfter });
    }
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required', code: 'missing-fields' });

    const result = await auth.authenticate(username, password);
    if (!result.ok) {
      limiter.fail(req);
      provider.clearSession(req, res);
      return res.status(401).json({ error: result.error || 'Invalid credentials' });
    }
    limiter.clear(req);
    const trustDevice = req.body?.trustDevice === true;
    await provider.issueSession(req, res, {
      trustDevice,
      claims: { authMethod: 'ad', username, profile: result.profile },
    });
    const client = req.body?.issueClientToken === true ? await mintClientToken(username, trustDevice) : null;
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      authenticated: true,
      profile: result.profile,
      ...(client ? { clientToken: client.token, client: client.client } : {}),
    });
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
      loginStarts.reset();
    },
  };
};
