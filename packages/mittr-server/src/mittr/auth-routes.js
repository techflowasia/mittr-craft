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

const statusOf = (session) => (session
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
  // Set when this host cannot keep tokens safely: every route that would
  // sign in or change the stored accounts answers it instead.
  signInRefusal = null,
  // Called once a session for the same account has been stored again.
  onSignIn = null,
  // Called with the next active userId (or null) when the active account changes.
  onAccountChange = null,
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

  const refuseWhenUnsafe = (_req, res, next) => (signInRefusal ? res.status(503).json({ error: signInRefusal }) : next());

  // One pending sign-in at a time. Starting a second replaces the first, so a
  // callback for an abandoned attempt can never be redeemed later.
  let pending = null;

  // One refresh in flight per account. Mittr rotates both tokens and kills the
  // old refresh token as it answers, so a second concurrent call would present
  // a dead token and sign the developer out mid-task.
  const refreshing = new Map();

  const announceAccountChange = async (nextUserId) => {
    if (!onAccountChange) return;
    try {
      await onAccountChange(nextUserId);
    } catch (error) {
      logger.warn('[mittr] switching account failed:', error?.message ?? error);
    }
  };

  const activeUserId = () => store.read()?.subject.userId ?? null;

  const failure = (status, error) => ({ status, body: { error } });

  const signIn = async (callbackUrl) => {
    if (signInRefusal) return failure(503, signInRefusal);
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
      });
    } catch (error) {
      logger.error('[mittr] sign-in exchange failed:', error?.message ?? error);
      return failure(502, 'Cannot reach Mittr');
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
    store.write(session);

    if (before !== session.subject.userId) {
      await announceAccountChange(session.subject.userId);
    } else if (onSignIn) {
      // Sign-in has succeeded by now; a follow-up that fails never changes
      // the answer.
      try {
        await onSignIn();
      } catch (error) {
        logger.warn('[mittr] work after sign-in failed:', error?.message ?? error);
      }
    }

    return { status: 200, body: statusOf(session) };
  };

  app.post('/api/mittr/auth/start', refuseWhenUnsafe, (_req, res) => {
    pending = createTransaction({ now });
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

  app.get('/api/mittr/auth/status', (_req, res) => res.json(statusOf(store.read())));

  app.delete('/api/mittr/auth/session', refuseWhenUnsafe, async (_req, res) => {
    store.clear();
    const next = store.read();
    await announceAccountChange(next?.subject.userId ?? null);
    return res.json(statusOf(next));
  });

  app.get('/api/mittr/auth/accounts', (_req, res) => res.json({ accounts: store.list() }));

  app.post('/api/mittr/auth/accounts/activate', refuseWhenUnsafe, readJson, async (req, res) => {
    const userId = typeof req.body?.userId === 'string' ? req.body.userId : '';
    if (activeUserId() === userId) return res.json(statusOf(store.read()));
    try {
      store.activate(userId);
    } catch {
      return res.status(404).json({ error: 'That account is not signed in on this machine' });
    }
    await announceAccountChange(userId);
    return res.json(statusOf(store.read()));
  });

  const refresh = async (session) => {
    const { userId } = session.subject;
    try {
      const response = await fetchImpl(endpoint(ENDPOINT.refresh), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refreshToken }),
      });

      if (response.status === 401) {
        // Only the account this refresh was for: the active one may have
        // changed while it was in flight.
        const wasActive = activeUserId() === userId;
        store.signOut(userId);
        if (!wasActive) return null;
        const next = store.read();
        void announceAccountChange(next?.subject.userId ?? null);
        return next;
      }
      if (!response.ok) return store.read();

      const refreshed = parseSession(await response.json());
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
