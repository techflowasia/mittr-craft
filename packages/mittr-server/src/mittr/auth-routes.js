import { parseSession } from './session.js';
import { authRedirectUri, createTransaction, verifyCallback } from './sign-in.js';

// The platform's desktop endpoints. There is no `/api` prefix: on the platform
// `/api/auth/*` belongs to its auth middleware, which answers 404 for these.
const ENDPOINT = {
  start: '/auth/desktop/start',
  exchange: '/auth/desktop/exchange',
  refresh: '/auth/desktop/refresh',
};

// Refresh a little before expiry, so a request already in flight when the
// token turns over does not fail on a technicality.
export const REFRESH_MARGIN_MS = 60_000;

const BODY_LIMIT = '8kb';

// A platform that stops answering must not hold a sign-in, or every model call
// waiting on a refresh, open for good.
const PLATFORM_TIMEOUT_MS = 15_000;

const CANNOT_STORE = 'Cannot store the Mittr sign-in on this machine';

const UNREACHABLE = 'Cannot reach Mittr';

export const ACCOUNTS_DAMAGED = 'Your Mittr account list on this computer is damaged. Choose Repair to set it aside and sign in again.';

export const statusOf = (session) => (session
  ? { signedIn: true, userId: session.subject.userId, displayName: session.subject.displayName }
  : { signedIn: false });

/**
 * Mittr sign-in on the server: the PKCE start, the callback exchange, status,
 * sign-out, the account list and switch, and the refresh the shim relies on.
 * The routes sit under `/api`, so they carry the UI's own auth.
 */
export function registerMittrAuthRoutes(app, {
  express,
  broker,
  store,
  scheme,
  fetchImpl = fetch,
  now = Date.now,
  // Answers why this host cannot keep tokens safely, or null: every route
  // that would sign in or change the stored accounts answers it instead. It is
  // asked per request, never at setup, because the answer may cost a keychain
  // check that must not hold up the app's start.
  signInRefusal = () => null,
  // Called once a session for the same account has been stored again.
  onSignIn = null,
  // Called with the next active userId (or null) when the active account changes.
  onAccountChange = null,
  switchSettled = () => false,
  logger = console,
}) {
  const redirectUri = authRedirectUri(scheme);
  const endpoint = (route) => new URL(route, broker.baseUrl).toString();

  // Each route brings its own body parser: the server parses no JSON under
  // `/api`, so a route that assumed a parsed body would read undefined.
  const parseJson = express.json({ limit: BODY_LIMIT });
  const readJson = (req, res, next) => parseJson(req, res, (error) => {
    if (!error) return next();
    return res.status(error.status ?? 400).json({ error: 'Invalid request body' });
  });

  // Refused before any browser trip or exchange: no keychain on this host, or
  // an account list that cannot be written without losing who had which home.
  const currentRefusal = () => signInRefusal() ?? (store.damaged() ? ACCOUNTS_DAMAGED : null);

  const refuseWhenUnsafe = (_req, res, next) => {
    const refusal = currentRefusal();
    return refusal ? res.status(503).json({ error: refusal }) : next();
  };

  // One pending sign-in at a time. Starting a second replaces the first, so a
  // callback for an abandoned attempt can never be redeemed later.
  let pending = null;

  // One refresh in flight per account. Mittr rotates both tokens and kills the
  // old refresh token as it answers, so a second concurrent call would present
  // a dead token and sign the developer out mid-task.
  const refreshing = new Map();

  const announceAccountChange = async (nextUserId) => {
    if (!onAccountChange) return {};
    try {
      const outcome = await onAccountChange(nextUserId);
      return outcome?.engineRestarted === false ? { engineRestarted: false } : {};
    } catch (error) {
      logger.warn('[mittr] switching account failed:', error?.message ?? error);
      return { engineRestarted: false };
    }
  };

  const activeUserId = () => store.read()?.subject.userId ?? null;

  const failure = (status, error) => ({ status, body: { error } });

  // How the last sign-in from the browser ended, until the next one starts:
  // the deep link has no window to answer, so the gate reads it from status.
  let lastFailure = null;

  const signIn = async (callbackUrl) => {
    const refusal = currentRefusal();
    if (refusal) return failure(503, refusal);
    const result = await finishSignIn(callbackUrl);
    if (result.status === 200) lastFailure = null;
    else lastFailure = result.body.error === UNREACHABLE ? 'unreachable' : 'failed';
    return result;
  };

  const finishSignIn = async (callbackUrl) => {
    let code;
    try {
      ({ code } = verifyCallback(pending, callbackUrl, { now, scheme }));
    } catch (error) {
      return failure(400, error.message);
    }

    // Spend the transaction before the exchange. Mittr spends the code on
    // first presentation whether or not it succeeds, so a retry against the
    // same transaction could never work and must not look like it might.
    const { verifier } = pending;
    pending = null;

    let response;
    try {
      response = await fetchImpl(endpoint(ENDPOINT.exchange), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: redirectUri }),
        signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
      });
    } catch (error) {
      logger.error('[mittr] sign-in exchange failed:', error?.message ?? error);
      return failure(502, UNREACHABLE);
    }

    if (!response.ok) return failure(response.status, 'Mittr rejected the sign-in');

    let session;
    try {
      session = parseSession(await response.json());
    } catch (error) {
      // A rejection and an unusable answer are different failures, and the
      // developer can act on only one of them.
      logger.error('[mittr] sign-in returned an unusable session:', error?.message ?? error);
      return failure(502, 'Mittr returned an unusable session');
    }

    const before = activeUserId();
    try {
      store.write(session);
    } catch (error) {
      logger.error('[mittr] could not store the sign-in:', error?.message ?? error);
      return failure(500, CANNOT_STORE);
    }

    let restart = {};
    if (before !== session.subject.userId) {
      restart = await announceAccountChange(session.subject.userId);
    } else if (onSignIn) {
      // Sign-in has succeeded by now; a follow-up that fails never changes
      // the answer.
      try {
        await onSignIn(before, session.subject.userId);
      } catch (error) {
        logger.warn('[mittr] work after sign-in failed:', error?.message ?? error);
      }
    }

    return { status: 200, body: { ...statusOf(session), ...restart } };
  };

  app.post('/api/mittr/auth/start', refuseWhenUnsafe, (_req, res) => {
    pending = createTransaction({ now });
    lastFailure = null;
    const authorizeUrl = new URL(ENDPOINT.start, broker.baseUrl);
    authorizeUrl.searchParams.set('code_challenge', pending.challenge);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    // The caller opens this: Electron in the system browser, the web UI by
    // navigating. The server never launches a browser itself.
    return res.json({ authorizeUrl: authorizeUrl.toString() });
  });

  app.post('/api/mittr/auth/callback', refuseWhenUnsafe, readJson, async (req, res) => {
    const { status, body } = await signIn(req.body?.url);
    return res.status(status).json(body);
  });

  app.get('/api/mittr/auth/status', (_req, res) => {
    const status = statusOf(store.read());
    if (signInRefusal()) status.keychainMissing = true;
    if (store.damaged()) status.accountsDamaged = true;
    if (lastFailure && !status.signedIn) status.signInFailed = lastFailure;
    return res.json(status);
  });

  app.post('/api/mittr/auth/accounts/repair', async (_req, res) => {
    const keychainRefusal = signInRefusal();
    if (keychainRefusal) return res.status(503).json({ error: keychainRefusal });
    let result;
    try {
      result = store.repair();
    } catch (error) {
      logger.error('[mittr] could not set the account list aside:', error?.message ?? error);
      return res.status(500).json({ error: CANNOT_STORE });
    }
    if (result.repaired) await announceAccountChange(activeUserId());
    return res.json({ repaired: result.repaired });
  });

  app.delete('/api/mittr/auth/session', refuseWhenUnsafe, async (_req, res) => {
    try {
      store.clear();
    } catch (error) {
      logger.error('[mittr] could not sign out:', error?.message ?? error);
      return res.status(500).json({ error: CANNOT_STORE });
    }
    lastFailure = null;
    const next = store.read();
    const restart = await announceAccountChange(next?.subject.userId ?? null);
    return res.json({ ...statusOf(next), ...restart });
  });

  app.get('/api/mittr/auth/accounts', (_req, res) => res.json({ accounts: store.list() }));

  app.post('/api/mittr/auth/accounts/activate', refuseWhenUnsafe, readJson, async (req, res) => {
    const userId = typeof req.body?.userId === 'string' ? req.body.userId : '';
    if (activeUserId() === userId) return res.json(statusOf(store.read()));
    if (!store.list().some((account) => account.userId === userId)) return res.status(404).json({ error: 'That account is not signed in on this machine' });
    try {
      store.activate(userId);
    } catch (error) {
      logger.error('[mittr] could not switch account:', error?.message ?? error);
      return res.status(500).json({ error: CANNOT_STORE });
    }
    lastFailure = null;
    const restart = await announceAccountChange(userId);
    return res.json({ ...statusOf(store.read()), ...restart });
  });

  app.post('/api/mittr/auth/accounts/retry-switch', refuseWhenUnsafe, async (_req, res) => {
    if (switchSettled()) return res.json(statusOf(store.read()));
    const restart = await announceAccountChange(activeUserId());
    return res.json({ ...statusOf(store.read()), ...restart });
  });

  const refresh = async (session) => {
    const { userId } = session.subject;
    // A sign-out, or a sign-out and a fresh sign-in, may land while the
    // request is out. The answer then belongs to a session that is gone, and
    // acting on it would bring the account back or sign the new session out.
    const stillCurrent = () => store.readOf(userId)?.refreshToken === session.refreshToken;
    try {
      const response = await fetchImpl(endpoint(ENDPOINT.refresh), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refreshToken }),
        signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
      });
      if (!stillCurrent()) return store.read();

      if (response.status === 401) {
        // Only the account this refresh was for: the active one may have
        // changed while it was in flight.
        const wasActive = activeUserId() === userId;
        store.signOut(userId);
        if (wasActive) void announceAccountChange(store.read()?.subject.userId ?? null);
        return null;
      }
      if (!response.ok) return store.read();

      const refreshed = parseSession(await response.json());
      if (!stillCurrent()) return store.read();
      store.write(refreshed, { activate: false });
      const current = store.read();
      return current?.subject.userId === refreshed.subject.userId ? refreshed : current;
    } catch {
      // A network failure is not a rejected token. Keeping the session lets
      // the caller report "cannot reach Mittr" instead of signing somebody
      // out because their wifi dropped.
      return store.read();
    }
  };

  /**
   * The active session, refreshed when it is within the margin of expiry.
   * Null only when there is no way to authenticate: no session, or a refresh
   * token Mittr has refused.
   */
  const ensureFreshSession = async () => {
    const session = store.read();
    if (!session) return null;
    if (session.expiresAt - now() > REFRESH_MARGIN_MS) return session;

    const { userId } = session.subject;
    if (!refreshing.has(userId)) {
      refreshing.set(userId, refresh(session).finally(() => refreshing.delete(userId)));
    }
    return refreshing.get(userId);
  };

  /** Finishes a sign-in from the callback URL; throws the refusal, with its HTTP status. */
  const completeSignIn = async (callbackUrl) => {
    const { status, body } = await signIn(callbackUrl);
    if (status !== 200) throw Object.assign(new Error(body.error), { status });
    return body;
  };

  return { ensureFreshSession, completeSignIn };
}
