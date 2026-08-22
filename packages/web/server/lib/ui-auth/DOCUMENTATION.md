# UI Auth Module Documentation

## Purpose
This module owns OpenChamber UI authentication for browser access, including password session auth, Microsoft Entra ID OIDC, WebAuthn passkeys, and trusted-device session handling.

Trusted-device access has one durable credential model: a remote client bearer token stored by `packages/web/server/lib/client-auth/remote-clients.js`. Password, passkey, and Pairing v2 are issuance methods for that credential, not separate credential systems. Issued client tokens are returned once, stored server-side only as hashes, and are later authenticated via `Authorization: Bearer oc_client_...`.

Pairing v2 is implemented by `packages/web/server/lib/client-auth/pairing.js`. It stores short-lived one-time pairing sessions with hashed secrets, exposes create/cancel/redeem routes under `/api/client-auth/pairing/*`, and redeems a valid pairing secret into the same remote client token used by password/passkey trusted-device flows.

## Entrypoints and structure
- `packages/web/server/lib/ui-auth/ui-auth.js`: UI auth controller runtime, cookie/session issuance, rate limiting, and auth route handlers.
- `packages/web/server/lib/ui-auth/entra-auth.js`: Microsoft Entra ID discovery, Authorization Code + PKCE transactions, token exchange, and ID-token verification.
- `packages/web/server/lib/ui-auth/ui-passkeys.js`: passkey store and WebAuthn registration/authentication verification helpers.
- `packages/web/server/lib/client-auth/remote-clients.js`: trusted-device client token storage, bearer authentication, last-used tracking, and revocation.
- `packages/web/server/lib/client-auth/pairing.js`: short-lived Pairing v2 sessions and one-time secret redemption into trusted-device client tokens.

## Public exports (ui-auth.js)
- `createUiAuth({ password, cookieName, sessionTtlMs, readSettingsFromDiskMigrated })`: creates UI auth controller with methods:
  - `enabled`
  - `requireAuth(req, res, next)`
  - `handleSessionStatus(req, res)`
  - `handleSessionCreate(req, res)`
  - `handleSessionDelete(req, res)`
  - `handlePasskeyStatus(req, res)`
  - `handlePasskeyRegistrationOptions(req, res)`
  - `handlePasskeyRegistrationVerify(req, res)`
  - `handlePasskeyAuthenticationOptions(req, res)`
  - `handlePasskeyAuthenticationVerify(req, res)`
  - `handlePasskeyList(req, res)`
  - `handlePasskeyRevoke(req, res)`
  - `handleResetAuth(req, res)`
  - `handleAdStatus(req, res)`
  - `handleAdLoginStart(req, res)`
  - `handleAdCallback(req, res)`
  - `handleAdDesktopRedeem(req, res)`
  - `handleAdProfile(req, res)`
  - `ensureSessionToken(req, res)`
  - `dispose()`

## Microsoft Entra ID

Entra login is enabled when all four server environment variables are present: `MITTR_AD_CLIENT_ID`, `MITTR_AD_CLIENT_SECRET`, `MITTR_AD_TENANT_ID`, and `MITTR_AD_REDIRECT_URI`. The redirect URI must exactly match the App Registration and normally ends in `/auth/ad/callback`; HTTPS is required except for loopback development URLs.

The server owns the client secret, one-time state and nonce values, PKCE verifier, code exchange, discovery document, signing keys, and ID-token validation. The browser receives only the Microsoft authorization redirect and the final HTTP-only OpenChamber session cookie. OpenChamber does not persist Microsoft access or refresh tokens. A partial Entra configuration fails closed instead of silently leaving the UI unauthenticated.

The redirect flow authenticates browser and hosted-web sessions. The login transaction retains a validated return target so a loopback HMR UI returns to its initiating UI origin instead of the backend's static root; same-origin targets are reduced to relative paths, and cross-origin targets are accepted only for loopback HTTP origins matching the login request Referrer.

Desktop uses the same Entra authorization flow in the system browser, followed by a short-lived one-time handoff. The renderer generates a random handoff ID and verifier, sends only the ID and SHA-256 challenge to `/auth/ad/login`, and polls `/auth/ad/desktop/redeem` with the verifier. After the browser callback verifies the Entra identity, redemption issues the existing remote-client bearer credential through the client-auth runtime. The server stores a normalized copy of the verified profile with that client record so `/auth/ad/profile` works for the bearer-authenticated Desktop after reload or restart; device listings do not expose the profile. An Entra client record created by an older build has no stored profile, so the profile route returns an explicit reauthentication response and the Desktop auth gate requests Microsoft login once to replace that legacy credential. The verifier, Microsoft tokens, and client credential are never placed in a URL or deep link; the browser callback does not create a browser UI session for Desktop handoffs. Handoffs expire after ten minutes, are memory-only, and permit one successful redemption. Tunnel and Private Relay scopes reject this browser handoff flow.

`DELETE /auth/session` signs out only the current browser UI session by expiring its HTTP-only session cookie. It is idempotent and does not rotate the server signing secret, clear passkeys, or revoke trusted-device client credentials.

## Public exports (ui-passkeys.js)
- `createUiPasskeys({ passwordBinding, readSettingsFromDiskMigrated, storeFile, rpName, challengeTtlMs })`: creates passkey runtime with methods:
  - `enabled`
  - `getStatus(req)`
  - `listPasskeys(req)`
  - `revokePasskey(req, passkeyId)`
  - `clearAllPasskeys()`
  - `beginRegistration(req, { label })`
  - `finishRegistration(payload)`
  - `beginAuthentication(req)`
  - `finishAuthentication(payload)`
  - `dispose()`
