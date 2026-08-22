import crypto from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createUiPasskeys } from './ui-passkeys.js';

const SESSION_COOKIE_NAME = 'oc_ui_session';
const AD_TRANSACTION_COOKIE_NAME = 'oc_ad_transaction';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const TRUSTED_DEVICE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const URL_AUTH_TOKEN_TTL_MS = 60 * 1000;
const URL_AUTH_TOKEN_PREFIX = 'oc_url_';
const DESKTOP_HANDOFF_TTL_MS = 10 * 60 * 1000;
const DESKTOP_HANDOFF_MAX_ENTRIES = 1_000;
const DESKTOP_HANDOFF_ID_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const DESKTOP_HANDOFF_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = Number(process.env.OPENCHAMBER_RATE_LIMIT_MAX_ATTEMPTS) || 10;
const RATE_LIMIT_LOCKOUT_MS = 15 * 60 * 1000;
const RATE_LIMIT_CLEANUP_MS = 60 * 60 * 1000;
const RATE_LIMIT_NO_IP_MAX_ATTEMPTS = Number(process.env.OPENCHAMBER_RATE_LIMIT_NO_IP_MAX_ATTEMPTS) || 3;

const loginRateLimiter = new Map();
let rateLimitCleanupTimer = null;

const rateLimitLocks = new Map();

const getClientIp = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const ip = forwarded.split(',')[0].trim();
    if (ip.startsWith('::ffff:')) {
      return ip.substring(7);
    }
    return ip;
  }

  const ip = req.ip || req.connection?.remoteAddress;
  if (ip) {
    if (ip.startsWith('::ffff:')) {
      return ip.substring(7);
    }
    return ip;
  }
  return null;
};

const getRateLimitKey = (req) => {
  const ip = getClientIp(req);
  if (ip) return ip;
  return 'rate-limit:no-ip';
};

const getRateLimitConfig = (key) => {
  if (key === 'rate-limit:no-ip') {
    return {
      maxAttempts: RATE_LIMIT_NO_IP_MAX_ATTEMPTS,
      windowMs: RATE_LIMIT_WINDOW_MS
    };
  }
  return {
    maxAttempts: RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: RATE_LIMIT_WINDOW_MS
  };
};

const acquireRateLimitLock = async (key) => {
  const prev = rateLimitLocks.get(key) || Promise.resolve();
  const curr = prev.then(() => rateLimitLocks.delete(key));
  rateLimitLocks.set(key, curr);
  await curr;
};

const checkRateLimit = async (req) => {
  const key = getRateLimitKey(req);
  await acquireRateLimitLock(key);

  const now = Date.now();
  const { maxAttempts } = getRateLimitConfig(key);

  let record;
  try {
    record = loginRateLimiter.get(key);
  } catch (err) {
    console.error('[RateLimit] Failed to get record', { key, error: err.message });
    return {
      allowed: true,
      limit: maxAttempts,
      remaining: maxAttempts,
      reset: Math.ceil((now + RATE_LIMIT_WINDOW_MS) / 1000)
    };
  }

  if (record?.lockedUntil && now < record.lockedUntil) {
    return {
      allowed: false,
      retryAfter: Math.ceil((record.lockedUntil - now) / 1000),
      locked: true,
      limit: maxAttempts,
      remaining: 0,
      reset: Math.ceil(record.lockedUntil / 1000)
    };
  }

  if (record?.lockedUntil && now >= record.lockedUntil) {
    try {
      loginRateLimiter.delete(key);
    } catch (err) {
      console.error('[RateLimit] Failed to delete expired record', { key, error: err.message });
    }
  }

  if (!record || now - record.lastAttempt > RATE_LIMIT_WINDOW_MS) {
    return {
      allowed: true,
      limit: maxAttempts,
      remaining: maxAttempts,
      reset: Math.ceil((now + RATE_LIMIT_WINDOW_MS) / 1000)
    };
  }

  if (record.count >= maxAttempts) {
    const lockedUntil = now + RATE_LIMIT_LOCKOUT_MS;
    try {
      loginRateLimiter.set(key, { count: record.count + 1, lastAttempt: now, lockedUntil });
    } catch (err) {
      console.error('[RateLimit] Failed to set lockout', { key, error: err.message });
    }
    return {
      allowed: false,
      retryAfter: Math.ceil(RATE_LIMIT_LOCKOUT_MS / 1000),
      locked: true,
      limit: maxAttempts,
      remaining: 0,
      reset: Math.ceil(lockedUntil / 1000)
    };
  }

  const remaining = maxAttempts - record.count;
  const reset = Math.ceil((record.lastAttempt + RATE_LIMIT_WINDOW_MS) / 1000);
  return {
    allowed: true,
    limit: maxAttempts,
    remaining,
    reset
  };
};

const recordFailedAttempt = async (req) => {
  const key = getRateLimitKey(req);
  await acquireRateLimitLock(key);

  const now = Date.now();
  const { maxAttempts } = getRateLimitConfig(key);
  const record = loginRateLimiter.get(key);

  if (!record || now - record.lastAttempt > RATE_LIMIT_WINDOW_MS) {
    try {
      loginRateLimiter.set(key, { count: 1, lastAttempt: now });
    } catch (err) {
      console.error('[RateLimit] Failed to record attempt', { key, error: err.message });
    }
  } else {
    const newCount = record.count + 1;
    try {
      loginRateLimiter.set(key, { count: newCount, lastAttempt: now });
    } catch (err) {
      console.error('[RateLimit] Failed to record attempt', { key, error: err.message });
    }
  }
};

const clearRateLimit = async (req) => {
  const key = getRateLimitKey(req);
  await acquireRateLimitLock(key);

  try {
    loginRateLimiter.delete(key);
  } catch (err) {
    console.error('[RateLimit] Failed to clear', { key, error: err.message });
  }
};

const cleanupRateLimitRecords = () => {
  const now = Date.now();
  for (const [key, record] of loginRateLimiter.entries()) {
    const isExpired = record.lockedUntil && now >= record.lockedUntil;
    const isStale = now - record.lastAttempt > RATE_LIMIT_CLEANUP_MS;
    if (isExpired || isStale) {
      try {
        loginRateLimiter.delete(key);
      } catch (err) {
        console.error('[RateLimit] Cleanup failed', { key, error: err.message });
      }
    }
  }
};

const startRateLimitCleanup = () => {
  if (!rateLimitCleanupTimer) {
    rateLimitCleanupTimer = setInterval(cleanupRateLimitRecords, RATE_LIMIT_CLEANUP_MS);
    if (rateLimitCleanupTimer && typeof rateLimitCleanupTimer.unref === 'function') {
      rateLimitCleanupTimer.unref();
    }
  }
};

const stopRateLimitCleanup = () => {
  if (rateLimitCleanupTimer) {
    clearInterval(rateLimitCleanupTimer);
    rateLimitCleanupTimer = null;
  }
};

const isSecureRequest = (req) => {
  if (req.secure) {
    return true;
  }
  const forwardedProto = req.headers['x-forwarded-proto'];
  if (typeof forwardedProto === 'string') {
    const firstProto = forwardedProto.split(',')[0]?.trim().toLowerCase();
    return firstProto === 'https';
  }
  return false;
};

const readHeader = (req, name) => {
  const value = req?.headers?.[name];
  return typeof value === 'string' ? value.trim() : '';
};

const isLoopbackHostname = (hostname) => {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
};

const resolveAdReturnTo = (req) => {
  const rawReturnTo = typeof req?.query?.returnTo === 'string' ? req.query.returnTo.trim() : '';
  if (!rawReturnTo) return '/';
  try {
    const target = new URL(rawReturnTo);
    if ((target.protocol !== 'http:' && target.protocol !== 'https:') || target.username || target.password || target.hash) {
      return '/';
    }
    const requestHost = readHeader(req, 'host');
    if (!requestHost) return '/';
    const requestOrigin = new URL(`${isSecureRequest(req) ? 'https' : 'http'}://${requestHost}`);
    if (target.origin === requestOrigin.origin) return `${target.pathname}${target.search}`;

    const referrer = readHeader(req, 'referer');
    const referrerOrigin = referrer ? new URL(referrer).origin : '';
    if (
      target.protocol === 'http:'
      && isLoopbackHostname(target.hostname)
      && isLoopbackHostname(requestOrigin.hostname)
      && target.origin === referrerOrigin
    ) {
      return `${target.origin}${target.pathname}${target.search}`;
    }
  } catch {
  }
  return '/';
};

const parseCookies = (cookieHeader) => {
  if (!cookieHeader || typeof cookieHeader !== 'string') {
    return {};
  }

  return cookieHeader.split(';').reduce((acc, segment) => {
    const [name, ...rest] = segment.split('=');
    if (!name) {
      return acc;
    }
    const key = name.trim();
    if (!key) {
      return acc;
    }
    const value = rest.join('=').trim();
    try {
      acc[key] = decodeURIComponent(value || '');
    } catch {
      acc[key] = value || '';
    }
    return acc;
  }, {});
};

const getBearerTokenFromRequest = (req) => {
  const header = req?.headers?.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === 'string') {
    const match = value.match(/^Bearer\s+(.+)$/i);
    const token = match?.[1]?.trim() || '';
    if (token) return token;
  }
  return null;
};

const getUrlAuthTokenFromRequest = (req) => {
  const queryToken = req?.query?.oc_url_token;
  let token = Array.isArray(queryToken) ? queryToken[0] : queryToken;
  if (typeof token !== 'string' && typeof req?.url === 'string') {
    try {
      token = new URL(req.url, 'http://localhost').searchParams.get('oc_url_token') || undefined;
    } catch {
      token = undefined;
    }
  }
  return typeof token === 'string' && token.trim() ? token.trim() : null;
};

const normalizeDesktopHandoff = (handoffId, challenge) => {
  const normalizedId = typeof handoffId === 'string' ? handoffId.trim() : '';
  const normalizedChallenge = typeof challenge === 'string' ? challenge.trim() : '';
  if (!DESKTOP_HANDOFF_ID_PATTERN.test(normalizedId) || !DESKTOP_HANDOFF_CHALLENGE_PATTERN.test(normalizedChallenge)) {
    return null;
  }
  return { handoffId: normalizedId, challenge: normalizedChallenge };
};

const desktopHandoffSuccessPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>Microsoft sign-in complete</title>
  <style>body{margin:0;background:#111827;color:#f9fafb;font-family:system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}.card{max-width:32rem;padding:2rem;text-align:center}h1{font-size:1.5rem;margin:0 0 .75rem}p{color:#d1d5db;line-height:1.5}</style>
</head>
<body><main class="card"><h1>Microsoft sign-in complete</h1><p>You can close this window and return to MittrCraft Desktop.</p></main></body>
</html>`;

const getRequestPathname = (req) => {
  const rawUrl = req?.originalUrl || req?.url;
  if (typeof rawUrl === 'string' && rawUrl) {
    try {
      return new URL(rawUrl, 'http://localhost').pathname;
    } catch {
      // Fall through to Express' derived path fields.
    }
  }
  if (typeof req?.baseUrl === 'string' && req.baseUrl && typeof req?.path === 'string' && req.path) {
    return `${req.baseUrl}${req.path}`.replace(/\/+/g, '/');
  }
  if (typeof req?.path === 'string' && req.path) return req.path;
  return '';
};

const isWebSocketUpgrade = (req) => {
  const upgrade = req?.headers?.upgrade;
  const upgradeValue = Array.isArray(upgrade) ? upgrade[0] : upgrade;
  return String(upgradeValue || '').toLowerCase() === 'websocket';
};

const isUrlAuthReadableHttpPath = (pathname) => {
  return pathname === '/api/event'
    || pathname === '/api/global/event'
    || pathname === '/api/openchamber/events'
    || pathname === '/api/openchamber/realtime-proxy/sse'
    || pathname === '/api/notifications/stream'
    || pathname === '/api/fs/raw'
    || pathname === '/api/fs/serve'
    || pathname.startsWith('/api/fs/serve/')
    || pathname.startsWith('/api/preview/proxy/')
    || /^\/api\/projects\/[^/]+\/icon$/.test(pathname);
};

const isUrlAuthWebSocketPath = (pathname) => {
  return pathname === '/api/event/ws'
    || pathname === '/api/global/event/ws'
    || pathname === '/api/openchamber/realtime-proxy/ws'
    || pathname === '/api/terminal/ws'
    || pathname === '/api/dictation/ws'
    || pathname.startsWith('/api/preview/proxy/');
};

const canUseUrlAuthTokenForRequest = (req) => {
  const method = typeof req?.method === 'string' ? req.method.toUpperCase() : 'GET';
  const pathname = getRequestPathname(req);
  if (isWebSocketUpgrade(req)) {
    return isUrlAuthWebSocketPath(pathname);
  }
  return method === 'GET' && isUrlAuthReadableHttpPath(pathname);
};

const buildCookie = ({
  name,
  value,
  maxAge,
  secure,
  cookiePath = '/',
  sameSite = 'Strict',
}) => {
  const attributes = [
    `${name}=${value}`,
    `Path=${cookiePath}`,
    'HttpOnly',
    `SameSite=${sameSite}`,
  ];

  if (typeof maxAge === 'number') {
    attributes.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  }

  const expires = maxAge === 0
    ? 'Thu, 01 Jan 1970 00:00:00 GMT'
    : new Date(Date.now() + maxAge * 1000).toUTCString();

  attributes.push(`Expires=${expires}`);

  if (secure) {
    attributes.push('Secure');
  }

  return attributes.join('; ');
};

const appendSetCookieHeader = (res, cookie) => {
  const current = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : undefined;
  if (Array.isArray(current)) {
    res.setHeader('Set-Cookie', [...current, cookie]);
  } else if (typeof current === 'string' && current) {
    res.setHeader('Set-Cookie', [current, cookie]);
  } else {
    res.setHeader('Set-Cookie', cookie);
  }
};

const normalizePassword = (candidate) => {
  if (typeof candidate !== 'string') {
    return '';
  }
  return candidate.normalize().trim();
};

const isTrustedDeviceRequest = (value) => value === true;

const OPENCHAMBER_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');
const JWT_SECRET_FILE = path.join(OPENCHAMBER_DATA_DIR, 'jwt-secret');

function getOrCreateJwtSecret() {
  const envSecret = process.env.OPENCODE_JWT_SECRET;
  if (envSecret) {
    return new TextEncoder().encode(envSecret);
  }

  try {
    if (fs.existsSync(JWT_SECRET_FILE)) {
      return new TextEncoder().encode(fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim());
    }
  } catch (e) {
    console.warn('[JWT] Failed to read secret file:', e.message);
  }

  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(OPENCHAMBER_DATA_DIR, { recursive: true });
    fs.writeFileSync(JWT_SECRET_FILE, secret, { mode: 0o600 });
    console.log('[JWT] Generated and persisted new secret to', JWT_SECRET_FILE);
  } catch (e) {
    console.warn('[JWT] Failed to persist secret:', e.message);
  }

  return new TextEncoder().encode(secret);
}

function persistJwtSecret(secret) {
  if (process.env.OPENCODE_JWT_SECRET) {
    const error = new Error('Global sign-out is unavailable while OPENCODE_JWT_SECRET is set');
    error.statusCode = 400;
    throw error;
  }

  fs.mkdirSync(OPENCHAMBER_DATA_DIR, { recursive: true });
  fs.writeFileSync(JWT_SECRET_FILE, secret, { mode: 0o600 });
  return new TextEncoder().encode(secret);
}

export const createUiAuth = ({
  password,
  cookieName = SESSION_COOKIE_NAME,
  sessionTtlMs = SESSION_TTL_MS,
  readSettingsFromDiskMigrated,
  clientAuthController = null,
  requireClientAuth = false,
  adAuthController = null,
} = {}) => {
  const normalizedPassword = normalizePassword(password);
  const passwordEnabled = Boolean(normalizedPassword);
  const adEnabled = adAuthController?.enabled === true;
  const adConfigurationPresent = adAuthController?.configurationPresent === true;
  const urlAuthTokens = new Map();
  const desktopHandoffs = new Map();

  const sweepDesktopHandoffs = () => {
    const timestamp = Date.now();
    for (const [handoffId, handoff] of desktopHandoffs.entries()) {
      if (!handoff || handoff.expiresAt <= timestamp) desktopHandoffs.delete(handoffId);
    }
  };

  const sweepUrlAuthTokens = () => {
    const now = Date.now();
    for (const [token, entry] of urlAuthTokens.entries()) {
      if (!entry || entry.expiresAt <= now) {
        urlAuthTokens.delete(token);
      }
    }
  };

  const issueUrlAuthTokenForSession = (sessionToken) => {
    sweepUrlAuthTokens();
    const token = `${URL_AUTH_TOKEN_PREFIX}${crypto.randomBytes(24).toString('base64url')}`;
    const expiresAt = Date.now() + URL_AUTH_TOKEN_TTL_MS;
    urlAuthTokens.set(token, { sessionToken, expiresAt });
    return { token, expiresAt };
  };

  const authenticateUrlAuthToken = (req) => {
    if (!canUseUrlAuthTokenForRequest(req)) return null;
    const token = getUrlAuthTokenFromRequest(req);
    if (!token || !token.startsWith(URL_AUTH_TOKEN_PREFIX)) return null;
    const entry = urlAuthTokens.get(token);
    if (!entry || entry.expiresAt <= Date.now()) {
      urlAuthTokens.delete(token);
      return null;
    }
    return { ok: true, sessionToken: entry.sessionToken || 'url:authenticated' };
  };

  const authenticateClientRequest = async (req, { allowUrlToken = true } = {}) => {
    if (allowUrlToken) {
      const urlAuth = authenticateUrlAuthToken(req);
      if (urlAuth) return urlAuth;
    }
    const token = getBearerTokenFromRequest(req);
    if (!token || typeof clientAuthController?.authenticateBearerToken !== 'function') {
      return null;
    }
    try {
      const result = await clientAuthController.authenticateBearerToken(token, req);
      if (result?.ok) {
        return result;
      }
      return null;
    } catch {
      return null;
    }
  };

  const clientSessionToken = (clientAuth) => {
    const raw = clientAuth?.sessionToken || clientAuth?.clientId || clientAuth?.id;
    if (typeof raw === 'string' && (raw.startsWith('client:') || raw.startsWith('url:'))) return raw;
    return typeof raw === 'string' && raw.length > 0 ? `client:${raw}` : 'client:authenticated';
  };

  const clientAuthClientId = (clientAuth) => {
    const raw = clientAuth?.client?.id || clientAuth?.clientId || clientAuth?.id || clientAuth?.sessionToken;
    if (typeof raw !== 'string' || raw.length === 0) return null;
    return raw.startsWith('client:') ? raw.slice('client:'.length) : raw;
  };

  const clientAuthContext = (clientAuth) => ({
    type: 'client',
    token: clientSessionToken(clientAuth),
    clientId: clientAuthClientId(clientAuth),
    client: clientAuth?.client || null,
  });

  const clearSessionCookie = (req, res) => {
    const secure = isSecureRequest(req);
    const header = buildCookie({
      name: cookieName,
      value: '',
      maxAge: 0,
      secure,
    });
    appendSetCookieHeader(res, header);
  };

  const revokeSessionUrlAuthTokens = (req) => {
    const sessionToken = parseCookies(req.headers.cookie)[cookieName];
    if (!sessionToken) return;
    for (const [token, entry] of urlAuthTokens.entries()) {
      if (entry?.sessionToken === sessionToken) urlAuthTokens.delete(token);
    }
  };

  if (!passwordEnabled && !adEnabled && !adConfigurationPresent) {
    const setSessionCookie = (req, res, token, ttlMs = sessionTtlMs) => {
      const secure = isSecureRequest(req);
      const maxAgeSeconds = Math.floor(ttlMs / 1000);
      const header = buildCookie({
        name: cookieName,
        value: encodeURIComponent(token),
        maxAge: maxAgeSeconds,
        secure,
      });
      appendSetCookieHeader(res, header);
    };

    const ensureSessionToken = async (req, res) => {
      const cookies = parseCookies(req.headers.cookie);
      if (cookies[cookieName]) {
        return cookies[cookieName];
      }
      const token = crypto.randomBytes(32).toString('base64url');
      setSessionCookie(req, res, token, sessionTtlMs);
      return token;
    };

    const requireAuth = async (req, res, next) => {
      if (!requireClientAuth) {
        return next();
      }
      if (req.method === 'OPTIONS') {
        return next();
      }
      const clientAuth = await authenticateClientRequest(req);
      if (clientAuth) {
        return next();
      }
      return res.status(401).json({ error: 'Client authentication required', locked: true, clientAuthRequired: true });
    };

    const requireSessionAuth = async (req, res, next) => {
      if (!requireClientAuth) {
        return next();
      }
      if (req.method === 'OPTIONS') {
        return next();
      }
      return res.status(401).json({ error: 'UI session authentication required', locked: true });
    };

    const resolveAuthContext = async (req, res, { allowClientAuth = true, allowUrlToken = true } = {}) => {
      const cookies = parseCookies(req.headers.cookie);
      if (cookies[cookieName]) {
        return { type: 'session', token: cookies[cookieName] };
      }
      if (allowClientAuth) {
        const clientAuth = await authenticateClientRequest(req, { allowUrlToken });
        if (clientAuth) return clientAuthContext(clientAuth);
      }
      if (!requireClientAuth) {
        const token = await ensureSessionToken(req, res);
        return { type: 'session', token };
      }
      return null;
    };

    return {
      enabled: false,
      requireAuth,
      requireSessionAuth,
      resolveAuthContext,
      handleSessionStatus: async (req, res) => {
        if (requireClientAuth) {
          const clientAuth = await authenticateClientRequest(req);
          if (clientAuth) {
            return res.json({ authenticated: true, disabled: true, scope: 'client' });
          }
          return res.status(401).json({ authenticated: false, locked: true, clientAuthRequired: true });
        }
        res.json({ authenticated: true, disabled: true });
      },
      handleSessionCreate: (_req, res) => {
        res.status(400).json({ error: 'UI password not configured' });
      },
      handleSessionDelete: (req, res) => {
        revokeSessionUrlAuthTokens(req);
        clearSessionCookie(req, res);
        res.setHeader('Cache-Control', 'no-store');
        res.json({ authenticated: false });
      },
      handleUrlAuthToken: async (req, res) => {
        const clientAuth = await authenticateClientRequest(req, { allowUrlToken: false });
        if (clientAuth) {
          res.setHeader('Cache-Control', 'no-store');
          return res.json(issueUrlAuthTokenForSession(clientSessionToken(clientAuth)));
        }
        if (requireClientAuth) {
          return res.status(401).json({ error: 'Client authentication required', locked: true, clientAuthRequired: true });
        }
        const sessionToken = await ensureSessionToken(req, res);
        res.setHeader('Cache-Control', 'no-store');
        return res.json(issueUrlAuthTokenForSession(sessionToken));
      },
      handlePasskeyStatus: (_req, res) => {
        res.json({ enabled: false, hasPasskeys: false, passkeyCount: 0, rpID: null });
      },
      handlePasskeyRegistrationOptions: (_req, res) => {
        res.status(400).json({ error: 'UI password not configured' });
      },
      handlePasskeyRegistrationVerify: (_req, res) => {
        res.status(400).json({ error: 'UI password not configured' });
      },
      handlePasskeyAuthenticationOptions: (_req, res) => {
        res.status(400).json({ error: 'UI password not configured' });
      },
      handlePasskeyAuthenticationVerify: (_req, res) => {
        res.status(400).json({ error: 'UI password not configured' });
      },
      handlePasskeyList: (_req, res) => {
        res.json({ passkeys: [] });
      },
      handlePasskeyRevoke: (_req, res) => {
        res.status(400).json({ error: 'UI password not configured' });
      },
      handleResetAuth: (_req, res) => {
        res.status(400).json({ error: 'UI password not configured' });
      },
      handleAdStatus: (_req, res) => {
        if (!adAuthController) {
          return res.json({ enabled: false });
        }
        return res.json(adAuthController.getStatus());
      },
      handleAdSessionCreate: async (req, res) => {
        return res.status(400).json({ error: 'AD authentication not configured' });
      },
      handleAdLoginStart: (_req, res) => {
        res.status(400).json({ error: 'Microsoft authentication not configured' });
      },
      handleAdCallback: (_req, res) => {
        res.status(400).send('Microsoft authentication is not configured');
      },
      handleAdDesktopRedeem: (_req, res) => {
        res.status(400).json({ error: 'Microsoft authentication not configured' });
      },
      handleAdProfile: (_req, res) => {
        res.status(400).json({ error: 'AD authentication not configured' });
      },
      ensureSessionToken: async (req, res) => {
        const clientAuth = await authenticateClientRequest(req);
        if (clientAuth) return clientSessionToken(clientAuth);
        return ensureSessionToken(req, res);
      },
      dispose: () => {

      },
    };
  }

  const salt = crypto.randomBytes(16);
  const expectedHash = crypto.scryptSync(normalizedPassword, salt, 64);
  let jwtSecret = getOrCreateJwtSecret();
  let passwordBinding = passwordEnabled
    ? crypto.createHmac('sha256', jwtSecret).update(normalizedPassword).digest('hex')
    : '';
  const resolveSessionTtlMs = (trustDevice) => (trustDevice ? TRUSTED_DEVICE_SESSION_TTL_MS : sessionTtlMs);
  let passkeyController = createUiPasskeys({
    passwordBinding,
    readSettingsFromDiskMigrated,
  });

  const rebuildPasskeyController = () => {
    passkeyController.dispose();
    passwordBinding = passwordEnabled
      ? crypto.createHmac('sha256', jwtSecret).update(normalizedPassword).digest('hex')
      : '';
    passkeyController = createUiPasskeys({
      passwordBinding,
      readSettingsFromDiskMigrated,
    });
  };

  const rotateJwtSecret = () => {
    const nextSecret = crypto.randomBytes(32).toString('hex');
    jwtSecret = persistJwtSecret(nextSecret);
    urlAuthTokens.clear();
    rebuildPasskeyController();
  };

  const getTokenFromRequest = (req) => {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[cookieName]) {
      return cookies[cookieName];
    }
    return null;
  };

  const setSessionCookie = (req, res, token, ttlMs) => {
    const secure = isSecureRequest(req);
    const maxAgeSeconds = Math.floor(ttlMs / 1000);
    const header = buildCookie({
      name: cookieName,
      value: encodeURIComponent(token),
      maxAge: maxAgeSeconds,
      secure,
    });
    appendSetCookieHeader(res, header);
  };

  const verifyPassword = (candidate) => {
    if (!candidate) {
      return false;
    }
    const normalizedCandidate = normalizePassword(candidate);
    if (!normalizedCandidate) {
      return false;
    }
    try {
      const candidateHash = crypto.scryptSync(normalizedCandidate, salt, 64);
      return crypto.timingSafeEqual(candidateHash, expectedHash);
    } catch {
      return false;
    }
  };

  const isSessionValid = async (token) => {
    if (!token) {
      return false;
    }
    try {
      await jwtVerify(token, jwtSecret);
      return true;
    } catch {
      return false;
    }
  };

  const issueSession = async (req, res, { trustDevice = false, claims = {} } = {}) => {
    const ttlMs = resolveSessionTtlMs(trustDevice);
    const token = await new SignJWT({ type: 'ui-session', ...claims })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(ttlMs / 1000 + 's')
      .sign(jwtSecret);
    setSessionCookie(req, res, token, ttlMs);
    return token;
  };

  startRateLimitCleanup();

  const respondUnauthorized = (req, res) => {
    res.status(401);
    const acceptsJson = req.headers.accept?.includes('application/json');
    if (acceptsJson || req.path?.startsWith('/api')) {
      res.json({ error: 'UI authentication required', locked: true });
    } else {
      res.type('text/plain').send('Authentication required');
    }
  };

  const requireAuth = async (req, res, next) => {
    if (req.method === 'OPTIONS') {
      return next();
    }
    const token = getTokenFromRequest(req);
    if (await isSessionValid(token)) {
      return next();
    }
    const clientAuth = await authenticateClientRequest(req);
    if (clientAuth) {
      return next();
    }
    clearSessionCookie(req, res);
    return respondUnauthorized(req, res);
  };

  const requireSessionAuth = async (req, res, next) => {
    if (req.method === 'OPTIONS') {
      return next();
    }
    const token = getTokenFromRequest(req);
    if (await isSessionValid(token)) {
      return next();
    }
    clearSessionCookie(req, res);
    return respondUnauthorized(req, res);
  };

  const handleSessionStatus = async (req, res) => {
    // An explicit bearer credential decides the answer on its own. Native
    // clients probe with the token their runtime transport will actually use;
    // falling back to the ambient session cookie here masked revoked tokens
    // (cookie said "authenticated", every bearer-only API call then 401'd).
    const authorization = req.headers?.authorization;
    const hasBearer = typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ');
    if (hasBearer) {
      const clientAuth = await authenticateClientRequest(req, { allowUrlToken: false });
      if (clientAuth) {
        res.json({ authenticated: true, scope: 'client' });
        return;
      }
      res.status(401).json({ authenticated: false, locked: true });
      return;
    }
    const token = getTokenFromRequest(req);
    if (await isSessionValid(token)) {
      res.json({ authenticated: true });
      return;
    }
    const clientAuth = await authenticateClientRequest(req);
    if (clientAuth) {
      res.json({ authenticated: true, scope: 'client' });
      return;
    }
    clearSessionCookie(req, res);
    res.status(401).json({ authenticated: false, locked: true });
  };

  const resolveAuthenticatedSessionToken = async (req, { allowUrlToken = true } = {}) => {
    const token = getTokenFromRequest(req);
    if (await isSessionValid(token)) {
      return token;
    }
    const clientAuth = await authenticateClientRequest(req, { allowUrlToken });
    return clientAuth ? clientSessionToken(clientAuth) : null;
  };

  const resolveAuthContext = async (req, _res, { allowClientAuth = true, allowUrlToken = true } = {}) => {
    const token = getTokenFromRequest(req);
    if (await isSessionValid(token)) {
      return { type: 'session', token };
    }
    if (!allowClientAuth) return null;
    const clientAuth = await authenticateClientRequest(req, { allowUrlToken });
    return clientAuth ? clientAuthContext(clientAuth) : null;
  };

  const handleUrlAuthToken = async (req, res) => {
    const sessionToken = await resolveAuthenticatedSessionToken(req, { allowUrlToken: false });
    if (!sessionToken) {
      clearSessionCookie(req, res);
      return respondUnauthorized(req, res);
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json(issueUrlAuthTokenForSession(sessionToken));
  };

  const handleSessionCreate = async (req, res) => {
    if (!passwordEnabled) {
      res.status(400).json({ error: 'UI password not configured' });
      return;
    }

    const rateLimitResult = await checkRateLimit(req);

    res.setHeader('X-RateLimit-Limit', rateLimitResult.limit);
    res.setHeader('X-RateLimit-Remaining', rateLimitResult.remaining);
    res.setHeader('X-RateLimit-Reset', rateLimitResult.reset);

    if (!rateLimitResult.allowed) {
      res.setHeader('Retry-After', rateLimitResult.retryAfter);
      res.status(429).json({ 
        error: 'Too many login attempts, please try again later',
        retryAfter: rateLimitResult.retryAfter 
      });
      return;
    }

    const candidate = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!verifyPassword(candidate)) {
      await recordFailedAttempt(req);
      clearSessionCookie(req, res);
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    await clearRateLimit(req);

    const trustDevice = isTrustedDeviceRequest(req.body?.trustDevice);
    const ttlMs = resolveSessionTtlMs(trustDevice);
    await issueSession(req, res, { trustDevice });
    let clientTokenResult = null;
    if (req.body?.issueClientToken === true && typeof clientAuthController?.createClient === 'function') {
      clientTokenResult = await clientAuthController.createClient({
        label: req.body?.clientLabel,
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        clientKind: req.body?.clientKind,
        dedupeKey: req.body?.dedupeKey,
        authMethod: 'password',
        deviceName: req.body?.deviceName,
        devicePlatform: req.body?.devicePlatform,
        deviceModel: req.body?.deviceModel,
        appVersion: req.body?.appVersion,
      });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      authenticated: true,
      ...(clientTokenResult?.token ? { clientToken: clientTokenResult.token, client: clientTokenResult.client } : {}),
    });
  };

  const handleSessionDelete = (req, res) => {
    revokeSessionUrlAuthTokens(req);
    clearSessionCookie(req, res);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ authenticated: false });
  };

  const respondPasskeyError = (res, error) => {
    const statusCode = typeof error?.statusCode === 'number' ? error.statusCode : 400;
    res.status(statusCode).json({ error: error?.message || 'Passkey request failed' });
  };

  const handlePasskeyStatus = (req, res) => {
    try {
      res.json(passkeyController.getStatus(req));
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyRegistrationOptions = async (req, res) => {
    try {
      const label = typeof req.body?.label === 'string' ? req.body.label : '';
      const options = await passkeyController.beginRegistration(req, { label });
      res.json(options);
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyRegistrationVerify = async (req, res) => {
    try {
      const result = await passkeyController.finishRegistration(req.body);
      res.json(result);
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyAuthenticationOptions = async (req, res) => {
    try {
      const options = await passkeyController.beginAuthentication(req);
      res.json(options);
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyAuthenticationVerify = async (req, res) => {
    try {
      await passkeyController.finishAuthentication(req.body);
      const trustDevice = isTrustedDeviceRequest(req.body?.trustDevice);
      const ttlMs = resolveSessionTtlMs(trustDevice);
      await issueSession(req, res, { trustDevice });
      let clientTokenResult = null;
      if (req.body?.issueClientToken === true && typeof clientAuthController?.createClient === 'function') {
        clientTokenResult = await clientAuthController.createClient({
          label: req.body?.clientLabel,
          expiresAt: new Date(Date.now() + ttlMs).toISOString(),
          clientKind: req.body?.clientKind,
          dedupeKey: req.body?.dedupeKey,
          authMethod: 'passkey',
          deviceName: req.body?.deviceName,
          devicePlatform: req.body?.devicePlatform,
          deviceModel: req.body?.deviceModel,
          appVersion: req.body?.appVersion,
        });
      }
      res.json({
        authenticated: true,
        ...(clientTokenResult?.token ? { clientToken: clientTokenResult.token, client: clientTokenResult.client } : {}),
      });
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyList = (req, res) => {
    try {
      res.json({ passkeys: passkeyController.listPasskeys(req) });
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyRevoke = (req, res) => {
    try {
      const result = passkeyController.revokePasskey(req, req.params?.id);
      res.json(result);
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handleResetAuth = (req, res) => {
    try {
      const passkeyResult = passkeyController.clearAllPasskeys();
      rotateJwtSecret();
      clearSessionCookie(req, res);
      res.json({
        cleared: true,
        clearedPasskeys: passkeyResult.clearedCount,
        signedOutEverywhere: true,
      });
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const dispose = () => {
    loginRateLimiter.clear();
    if (rateLimitCleanupTimer) {
      clearInterval(rateLimitCleanupTimer);
      rateLimitCleanupTimer = null;
    }
    passkeyController.dispose();
    desktopHandoffs.clear();
    if (adAuthController) {
      adAuthController.dispose();
    }
  };

  const handleAdStatus = (_req, res) => {
    if (!adAuthController) {
      return res.json({ enabled: false, passwordEnabled });
    }
    return res.json({ ...adAuthController.getStatus(), passwordEnabled, desktopHandoff: adAuthController.mode === 'entra' });
  };

  const handleAdSessionCreate = async (req, res) => {
    if (!adAuthController) {
      return res.status(400).json({ error: 'AD authentication not configured' });
    }
    if (adAuthController.mode === 'entra') {
      return res.status(400).json({ error: 'Use the Microsoft sign-in redirect' });
    }

    const rateLimitResult = await checkRateLimit(req);

    res.setHeader('X-RateLimit-Limit', rateLimitResult.limit);
    res.setHeader('X-RateLimit-Remaining', rateLimitResult.remaining);
    res.setHeader('X-RateLimit-Reset', rateLimitResult.reset);

    if (!rateLimitResult.allowed) {
      res.setHeader('Retry-After', rateLimitResult.retryAfter);
      res.status(429).json({
        error: 'Too many login attempts, please try again later',
        retryAfter: rateLimitResult.retryAfter,
      });
      return;
    }

    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const result = await adAuthController.authenticate(username, password);

    if (!result.ok) {
      await recordFailedAttempt(req);
      clearSessionCookie(req, res);
      return res.status(401).json({ error: result.error || 'Invalid credentials' });
    }

    await clearRateLimit(req);

    const trustDevice = isTrustedDeviceRequest(req.body?.trustDevice);
    const ttlMs = resolveSessionTtlMs(trustDevice);
    await issueSession(req, res, {
      trustDevice,
      claims: { authMethod: 'ad', username, profile: result.profile },
    });

    let clientTokenResult = null;
    if (req.body?.issueClientToken === true && typeof clientAuthController?.createClient === 'function') {
      clientTokenResult = await clientAuthController.createClient({
        label: req.body?.clientLabel,
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        clientKind: req.body?.clientKind,
        dedupeKey: req.body?.dedupeKey,
        authMethod: 'ad',
        authProfile: result.profile,
        deviceName: req.body?.deviceName,
        devicePlatform: req.body?.devicePlatform,
        deviceModel: req.body?.deviceModel,
        appVersion: req.body?.appVersion,
      });
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      authenticated: true,
      profile: result.profile,
      ...(clientTokenResult?.token ? { clientToken: clientTokenResult.token, client: clientTokenResult.client } : {}),
    });
  };

  const clearAdTransactionCookie = (req, res) => {
    appendSetCookieHeader(res, buildCookie({
      name: AD_TRANSACTION_COOKIE_NAME,
      value: '',
      maxAge: 0,
      secure: isSecureRequest(req),
      cookiePath: '/auth/ad/callback',
      sameSite: 'Lax',
    }));
  };

  const handleAdLoginStart = async (req, res) => {
    if (!adAuthController?.enabled || adAuthController.mode !== 'entra') {
      return res.status(400).json({ error: 'Microsoft authentication not configured' });
    }
    try {
      const trustDevice = req.query?.trustDevice === 'true' || req.query?.trustDevice === '1';
      const returnTo = resolveAdReturnTo(req);
      const desktopHandoff = normalizeDesktopHandoff(req.query?.desktopHandoff, req.query?.desktopChallenge);
      if ((req.query?.desktopHandoff || req.query?.desktopChallenge) && !desktopHandoff) {
        return res.status(400).json({ error: 'Desktop sign-in handoff is invalid' });
      }
      sweepDesktopHandoffs();
      if (desktopHandoff && desktopHandoffs.has(desktopHandoff.handoffId)) {
        return res.status(409).json({ error: 'Desktop sign-in handoff already exists' });
      }
      if (desktopHandoff && desktopHandoffs.size >= DESKTOP_HANDOFF_MAX_ENTRIES) {
        return res.status(503).json({ error: 'Too many pending Desktop sign-ins' });
      }
      const authorizationInput = {
        trustDevice,
        returnTo,
      };
      if (desktopHandoff) authorizationInput.desktopHandoff = desktopHandoff;
      const transaction = await adAuthController.beginAuthorization(authorizationInput);
      if (desktopHandoff) {
        desktopHandoffs.set(desktopHandoff.handoffId, {
          challenge: desktopHandoff.challenge,
          status: 'pending',
          trustDevice,
          expiresAt: Date.now() + DESKTOP_HANDOFF_TTL_MS,
        });
      }
      const maxAge = Math.max(1, Math.floor((transaction.expiresAt - Date.now()) / 1000));
      res.setHeader('Cache-Control', 'no-store');
      appendSetCookieHeader(res, buildCookie({
        name: AD_TRANSACTION_COOKIE_NAME,
        value: encodeURIComponent(transaction.state),
        maxAge,
        secure: isSecureRequest(req),
        cookiePath: '/auth/ad/callback',
        sameSite: 'Lax',
      }));
      return res.redirect(302, transaction.authorizationUrl);
    } catch (error) {
      console.error('[Entra] Failed to start sign-in:', error?.message || error);
      return res.status(502).json({ error: 'Unable to start Microsoft sign-in' });
    }
  };

  const handleAdCallback = async (req, res) => {
    if (!adAuthController?.enabled || adAuthController.mode !== 'entra') {
      return res.status(400).send('Microsoft authentication is not configured');
    }

    const state = typeof req.query?.state === 'string' ? req.query.state : '';
    const code = typeof req.query?.code === 'string' ? req.query.code : '';
    const providerError = typeof req.query?.error === 'string' ? req.query.error : '';
    const transactionCookie = parseCookies(req.headers.cookie)[AD_TRANSACTION_COOKIE_NAME] || '';
    clearAdTransactionCookie(req, res);
    res.setHeader('Cache-Control', 'no-store');

    if (providerError || !state || !code || transactionCookie !== state) {
      return res.status(400).send('Microsoft sign-in could not be verified. Return to MittrCraft and try again.');
    }

    try {
      const result = await adAuthController.completeAuthorization({ code, state });
      if (result.desktopHandoff) {
        sweepDesktopHandoffs();
        const handoff = desktopHandoffs.get(result.desktopHandoff.handoffId);
        if (
          !handoff
          || handoff.status !== 'pending'
          || handoff.challenge !== result.desktopHandoff.challenge
        ) {
          return res.status(400).send('Desktop sign-in handoff is invalid or expired. Return to MittrCraft and try again.');
        }
        handoff.status = 'completed';
        handoff.profile = result.profile;
        handoff.trustDevice = result.trustDevice;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(desktopHandoffSuccessPage);
      }
      await issueSession(req, res, {
        trustDevice: result.trustDevice,
        claims: { authMethod: 'entra', profile: result.profile },
      });
      return res.redirect(302, result.returnTo || '/');
    } catch (error) {
      console.error('[Entra] Sign-in callback failed:', error?.message || error);
      return res.status(401).send('Microsoft sign-in failed. Return to MittrCraft and try again.');
    }
  };

  const handleAdDesktopRedeem = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!adAuthController?.enabled || adAuthController.mode !== 'entra') {
      return res.status(400).json({ error: 'Microsoft authentication not configured' });
    }

    const handoffId = typeof req.body?.handoffId === 'string' ? req.body.handoffId.trim() : '';
    const verifier = typeof req.body?.verifier === 'string' ? req.body.verifier.trim() : '';
    if (!DESKTOP_HANDOFF_ID_PATTERN.test(handoffId) || !DESKTOP_HANDOFF_ID_PATTERN.test(verifier)) {
      return res.status(400).json({ error: 'Desktop sign-in handoff is invalid' });
    }

    sweepDesktopHandoffs();
    const handoff = desktopHandoffs.get(handoffId);
    if (!handoff) return res.status(404).json({ error: 'Desktop sign-in handoff was not found or expired' });

    const actualChallenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const expectedBuffer = Buffer.from(handoff.challenge);
    const actualBuffer = Buffer.from(actualChallenge);
    if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
      return res.status(401).json({ error: 'Desktop sign-in verifier is invalid' });
    }
    if (handoff.status === 'pending') return res.status(202).json({ pending: true });
    if (handoff.status !== 'completed') return res.status(409).json({ error: 'Desktop sign-in handoff was already used' });
    if (typeof clientAuthController?.createClient !== 'function') {
      return res.status(503).json({ error: 'Desktop client authentication is unavailable' });
    }

    handoff.status = 'redeeming';
    let result;
    try {
      const ttlMs = resolveSessionTtlMs(handoff.trustDevice);
      result = await clientAuthController.createClient({
        label: req.body?.clientLabel,
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        clientKind: req.body?.clientKind,
        dedupeKey: req.body?.dedupeKey,
        authMethod: 'entra',
        authProfile: handoff.profile,
        deviceName: req.body?.deviceName,
        devicePlatform: req.body?.devicePlatform,
        deviceModel: req.body?.deviceModel,
        appVersion: req.body?.appVersion,
      });
    } catch (error) {
      handoff.status = 'completed';
      throw error;
    }
    const profile = handoff.profile;
    handoff.status = 'consumed';
    handoff.profile = null;
    return res.json({ authenticated: true, profile, clientToken: result.token, client: result.client });
  };

  const handleAdProfile = async (req, res) => {
    if (!adAuthController) {
      return res.status(400).json({ error: 'AD authentication not configured' });
    }

    if (getBearerTokenFromRequest(req)) {
      const clientAuth = await authenticateClientRequest(req, { allowUrlToken: false });
      if (!clientAuth) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      if (!clientAuth.authProfile) {
        if (clientAuth.client?.authMethod === 'entra') {
          return res.status(409).json({ error: 'Microsoft sign-in must be renewed', reauthenticationRequired: true });
        }
        return res.status(404).json({ error: 'User profile not found' });
      }
      return res.json({ profile: clientAuth.authProfile });
    }

    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[cookieName];
    if (!token) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
      const payload = await jwtVerify(token, jwtSecret);
      if (payload?.payload?.authMethod === 'entra' && payload?.payload?.profile) {
        return res.json({ profile: payload.payload.profile });
      }
      const username = payload?.payload?.username;
      if (!username) {
        return res.status(400).json({ error: 'No username in session' });
      }

      const profile = await adAuthController.getProfile(username);
      if (!profile) {
        return res.status(404).json({ error: 'User profile not found' });
      }

      res.json({ profile });
    } catch {
      return res.status(401).json({ error: 'Invalid session' });
    }
  };

  return {
    enabled: true,
    requireAuth,
    requireSessionAuth,
    resolveAuthContext,
    handleSessionStatus,
    handleSessionCreate,
    handleSessionDelete,
    handleUrlAuthToken,
    handlePasskeyStatus,
    handlePasskeyRegistrationOptions,
    handlePasskeyRegistrationVerify,
    handlePasskeyAuthenticationOptions,
    handlePasskeyAuthenticationVerify,
    handlePasskeyList,
    handlePasskeyRevoke,
    handleResetAuth,
    handleAdStatus,
    handleAdSessionCreate,
    handleAdLoginStart,
    handleAdCallback,
    handleAdDesktopRedeem,
    handleAdProfile,
    ensureSessionToken: async (req, _res) => {
      return resolveAuthenticatedSessionToken(req);
    },
    dispose,
  };
};
