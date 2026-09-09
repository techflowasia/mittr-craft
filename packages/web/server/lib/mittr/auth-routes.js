import { createTransaction, verifyCallback } from './sign-in-transaction.js';
import { parseSession } from './session.js';

export const REDIRECT_URI = 'mittrcraft://auth/callback';

// Mittr's desktop endpoints, in one place because two handover documents from
// the platform side disagreed about the prefix: an earlier one wrote
// `/auth/desktop/*`, the later one — written after walking a running stack —
// wrote `/api/auth/desktop/*`. The later one is used. If it turns out to be
// wrong, this is the only edit.
const ENDPOINT = {
  start: '/api/auth/desktop/start',
  exchange: '/api/auth/desktop/exchange',
  refresh: '/api/auth/desktop/refresh',
};

// Refresh a little before expiry, so a request that is already in flight when
// the token turns over does not fail on a technicality.
const REFRESH_MARGIN_MS = 60_000;

export function registerMittrAuthRoutes(app, { brokerBaseUrl, sessionStore, fetchImpl = fetch }) {
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

  app.post('/api/mittr/auth/callback', async (req, res) => {
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
