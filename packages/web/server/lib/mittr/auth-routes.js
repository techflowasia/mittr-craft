import express from 'express';
import { createTransaction, verifyCallback } from './sign-in-transaction.js';
import { parseSession } from './session.js';

export const REDIRECT_URI = 'mittrcraft://auth/callback';

// Mittr's desktop endpoints, in one place because the prefix has been wrong
// twice. Two handover documents disagreed — `/auth/desktop/*` against
// `/api/auth/desktop/*` — and the second was taken because it was written later
// and against a running stack. It was still wrong: on 2026-09-09 the platform
// side checked prod and found `/api/auth/*` is Better Auth's own middleware,
// mounted ahead of the application's routes, answering 404 for anything it does
// not recognise. There is no `/api` prefix. Keeping them here is what made that
// a three-line correction.
const ENDPOINT = {
  start: '/auth/desktop/start',
  exchange: '/auth/desktop/exchange',
  refresh: '/auth/desktop/refresh',
};

// Each route brings its own body parser. The application does not parse JSON
// globally -- every other route that needs a body declares one -- so a route
// that assumes a parsed body reads undefined on the real server while passing
// every test whose harness happened to add one.
const readJson = (limit) => express.json({ limit });

// Refresh a little before expiry, so a request that is already in flight when
// the token turns over does not fail on a technicality.
const REFRESH_MARGIN_MS = 60_000;

export function registerMittrAuthRoutes(app, {
  brokerBaseUrl,
  sessionStore,
  fetchImpl = fetch,
  // Called once a session has been stored. The catalog is fetched here rather
  // than left to the client, so a person who signs in has models to choose from
  // without a second deliberate step they have no reason to know about.
  onSignIn = null,
}) {
  const url = (endpoint) => new URL(endpoint, brokerBaseUrl).toString();

  // One pending sign-in at a time. Starting a second replaces the first, which
  // also means a callback for an abandoned attempt can never be redeemed later.
  let pending = null;

  // One refresh in flight, shared. Mittr rotates both tokens and kills the old
  // refresh token as it answers, so a second concurrent call would present a
  // token that is already dead and sign the developer out mid-task.
  let refreshing = null;

  const statusOf = (session) => (session
    ? { signedIn: true, displayName: session.subject.displayName }
    : { signedIn: false });

  app.post('/api/mittr/auth/start', (_req, res) => {
    pending = createTransaction();
    const authorizeUrl = new URL(ENDPOINT.start, brokerBaseUrl);
    authorizeUrl.searchParams.set('code_challenge', pending.challenge);
    authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    // The caller opens this: Electron in the system browser, the web UI by
    // navigating. The server has no business launching a browser, and doing so
    // would have no meaning on every runtime that is not the desktop.
    return res.json({ authorizeUrl: authorizeUrl.toString() });
  });

  app.post('/api/mittr/auth/callback', readJson('8kb'), async (req, res) => {
    let code;
    try {
      ({ code } = verifyCallback(pending, req.body?.url));
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    // Spend the transaction before the exchange. Mittr spends the code on first
    // presentation whether or not it succeeds, so a retry against the same
    // transaction could never work and must not look like it might.
    const { verifier } = pending;
    pending = null;

    let response;
    try {
      response = await fetchImpl(url(ENDPOINT.exchange), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: REDIRECT_URI }),
      });
    } catch (error) {
      console.error('[mittr] sign-in exchange failed:', error?.message ?? error);
      return res.status(502).json({ error: 'Cannot reach Mittr' });
    }

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Mittr rejected the sign-in' });
    }

    let session;
    try {
      session = parseSession(await response.json());
    } catch (error) {
      // A rejection and an unusable answer are different failures and the
      // developer can act on only one of them, so they do not share a status.
      console.error('[mittr] sign-in returned an unusable session:', error?.message ?? error);
      return res.status(502).json({ error: 'Mittr returned an unusable session' });
    }

    sessionStore.write(session);

    if (onSignIn) {
      // Sign-in has already succeeded by this point. A catalog that cannot be
      // fetched is a smaller failure than a sign-in that reports itself failed,
      // so this never changes the answer.
      try {
        await onSignIn();
      } catch (error) {
        console.warn('[mittr] catalog sync after sign-in failed:', error?.message ?? error);
      }
    }

    return res.json(statusOf(session));
  });

  app.get('/api/mittr/auth/status', (_req, res) => res.json(statusOf(sessionStore.read())));

  app.delete('/api/mittr/auth/session', (_req, res) => {
    sessionStore.clear();
    return res.json({ signedIn: false });
  });

  /**
   * The session the shim should present, refreshed if it is close to expiry.
   * Returns null only when there is genuinely no way to authenticate: no
   * session at all, or a refresh token Mittr has rejected.
   */
  const ensureFreshSession = async () => {
    const session = sessionStore.read();
    if (!session) return null;
    if (session.expiresAt - Date.now() > REFRESH_MARGIN_MS) return session;

    if (!refreshing) {
      refreshing = (async () => {
        try {
          const response = await fetchImpl(url(ENDPOINT.refresh), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ refresh_token: session.refreshToken }),
          });

          if (response.status === 401) {
            sessionStore.clear();
            return null;
          }
          if (!response.ok) return sessionStore.read();

          const refreshed = parseSession(await response.json());
          sessionStore.write(refreshed);
          return refreshed;
        } catch {
          // A network failure is not a rejected token. Keeping the session lets
          // the caller report "cannot reach Mittr" instead of silently signing
          // somebody out because their wifi dropped.
          return sessionStore.read();
        } finally {
          refreshing = null;
        }
      })();
    }

    return refreshing;
  };

  return { ensureFreshSession };
}
