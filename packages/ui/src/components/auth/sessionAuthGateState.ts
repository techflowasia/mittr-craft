export type GateState = 'pending' | 'authenticated' | 'locked' | 'error' | 'rate-limited';

export type RuntimeIdentity = {
  apiBaseUrl: string;
  runtimeKey: string;
};

export const SESSION_AUTH_REQUIRED_EVENT = 'openchamber:session-auth-required';

export const requestSessionLogin = (): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(SESSION_AUTH_REQUIRED_EVENT));
};

export const runtimeIdentityMatches = (left: RuntimeIdentity, right: RuntimeIdentity): boolean => {
  return left.apiBaseUrl === right.apiBaseUrl && left.runtimeKey === right.runtimeKey;
};

export const resolveStatusCheckFailureState = (options: {
  shouldUseDesktopShellPasswordLogin?: boolean;
}): Exclude<GateState, 'pending' | 'authenticated' | 'rate-limited'> => {
  if (options.shouldUseDesktopShellPasswordLogin) {
    return 'locked';
  }

  return 'error';
};
