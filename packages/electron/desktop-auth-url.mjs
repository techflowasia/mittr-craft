const HANDOFF_ID_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const HANDOFF_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ALLOWED_QUERY_KEYS = new Set(['desktopHandoff', 'desktopChallenge', 'trustDevice']);

export const validateDesktopAuthUrl = (rawUrl, allowedOrigins) => {
  if (!rawUrl || rawUrl.constructor !== String) throw new Error('Authentication URL is required');
  if (!(allowedOrigins instanceof Set)) throw new Error('Authentication origins are unavailable');

  const parsed = new URL(rawUrl.trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Authentication URL must use HTTP or HTTPS');
  }
  if (parsed.username || parsed.password || parsed.hash || parsed.pathname !== '/auth/ad/login') {
    throw new Error('Authentication URL is not allowed');
  }
  if ([...parsed.searchParams.keys()].some((key) => !ALLOWED_QUERY_KEYS.has(key))) {
    throw new Error('Authentication URL contains unsupported parameters');
  }

  const handoffId = parsed.searchParams.get('desktopHandoff') || '';
  const challenge = parsed.searchParams.get('desktopChallenge') || '';
  if (!HANDOFF_ID_PATTERN.test(handoffId) || !HANDOFF_CHALLENGE_PATTERN.test(challenge)) {
    throw new Error('Authentication URL handoff is invalid');
  }
  const trustDevice = parsed.searchParams.get('trustDevice');
  if (trustDevice !== null && trustDevice !== 'true') {
    throw new Error('Authentication URL trust-device value is invalid');
  }
  if (!allowedOrigins.has(parsed.origin)) {
    throw new Error('Authentication URL origin is not configured in Desktop');
  }
  return parsed.toString();
};
