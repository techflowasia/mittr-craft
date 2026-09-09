/**
 * `parseDeepLink` in main.mjs puts the URL hostname in `type` and the joined
 * path segments in `value`, so `mittrcraft://auth/callback?code=…` arrives as
 * `{ type: 'auth', value: 'callback' }`.
 *
 * Recognising the link is all this does. Whether it is acted on is decided by
 * the local server, which redeems it only against a sign-in this machine
 * started — any application can register a URL scheme, so arriving is not
 * consent.
 */
export const isAuthCallbackLink = (link) => Boolean(
  link
  && link.type === 'auth'
  && link.value === 'callback'
  && typeof link.raw === 'string',
);
