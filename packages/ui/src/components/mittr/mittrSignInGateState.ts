export type MittrGateState = 'checking' | 'signed-out' | 'signed-in';

export type MittrSignInStatus = {
  signedIn: boolean;
  displayName: string;
};

/**
 * The status route answers from the local server, so this is a boundary: parse
 * it rather than trusting its shape.
 */
export const parseSignInStatus = (payload: unknown): MittrSignInStatus => {
  if (!payload || typeof payload !== 'object') return { signedIn: false, displayName: '' };
  const record = payload as Record<string, unknown>;
  return {
    signedIn: record.signedIn === true,
    displayName: typeof record.displayName === 'string' ? record.displayName : '',
  };
};

/**
 * A status check that fails tells us nothing, and the safe reading of nothing is
 * "not signed in": it shows a screen the developer can act on, and the worst
 * case is one unnecessary sign-in. Reading it as signed in would drop them into
 * an application whose every model call answers 401.
 */
export const gateStateFromStatus = (status: MittrSignInStatus | null): MittrGateState => {
  if (!status) return 'checking';
  return status.signedIn ? 'signed-in' : 'signed-out';
};

export const SIGN_IN_STATUS_ENDPOINT = '/api/mittr/auth/status';
export const SIGN_IN_START_ENDPOINT = '/api/mittr/auth/start';

/**
 * The authorize URL is opened by the caller, not the server: on the desktop the
 * shell sends it to the system browser, and on the web the tab navigates. Parse
 * it here so a malformed answer surfaces as a failed sign-in rather than as a
 * navigation to something unusable.
 */
export const parseAuthorizeUrl = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') return null;
  const url = (payload as Record<string, unknown>).authorizeUrl;
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const parsed = new URL(url);
    // Only ever a web address: this value is handed straight to a browser.
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
};
