import type { JsonValue } from '@openchamber/sdk';
import { z } from 'zod';

import type { MittrAccount } from '../accounts/accountsApi';

export type GateState = 'checking' | 'signed-out' | 'signed-in';

export type SignInFailure = 'unreachable' | 'failed';

export type SignInStatus = {
  signedIn: boolean;
  userId?: string;
  displayName?: string;
  accountsDamaged?: true;
  keychainMissing?: true;
  signInFailed?: SignInFailure;
  sessionEnded?: true;
};

export type GateAction = 'start' | 'repair';

export type GateSnapshot = {
  status: SignInStatus | null;
  checkFailed: boolean;
  actionFailed: GateAction | null;
  waiting: boolean;
  busy: boolean;
  accounts: MittrAccount[];
};

export type GateNotice =
  | 'no-keychain'
  | 'accounts-damaged'
  | 'repair-failed'
  | 'check-failed'
  | 'start-failed'
  | 'waiting'
  | 'sign-in-failed'
  | 'sign-in-unreachable'
  | 'session-ended';

export const SIGN_IN_STATUS_ENDPOINT = '/api/mittr/auth/status';
export const SIGN_IN_START_ENDPOINT = '/api/mittr/auth/start';
export const SIGN_IN_REPAIR_ENDPOINT = '/api/mittr/auth/accounts/repair';

// Emitted by the desktop shell once a deep-link sign-in has stored a session,
// or has failed. Neither carries a payload: the gate re-reads the status route.
export const SIGN_IN_COMPLETED_EVENT = 'mittrcraft:signed-in';
export const SIGN_IN_FAILED_EVENT = 'mittrcraft:sign-in-failed';

const statusPayload = z.object({
  signedIn: z.boolean().catch(false),
  userId: z.string().optional().catch(undefined),
  displayName: z.string().optional().catch(undefined),
  accountsDamaged: z.literal(true).optional().catch(undefined),
  keychainMissing: z.literal(true).optional().catch(undefined),
  signInFailed: z.enum(['unreachable', 'failed']).optional().catch(undefined),
  sessionEnded: z.literal(true).optional().catch(undefined),
});

// The status route is a boundary: anything but an exact `signedIn: true` is
// signed out, and a signed-out status keeps no user.
export function parseSignInStatus(payload: JsonValue): SignInStatus {
  const parsed = statusPayload.safeParse(payload);
  if (!parsed.success) return { signedIn: false };
  const { signedIn, userId, displayName, accountsDamaged, keychainMissing, signInFailed, sessionEnded } = parsed.data;
  const status: SignInStatus = { signedIn };
  if (signedIn && userId !== undefined) status.userId = userId;
  if (signedIn && displayName !== undefined) status.displayName = displayName;
  if (accountsDamaged) status.accountsDamaged = true;
  if (keychainMissing) status.keychainMissing = true;
  if (signInFailed) status.signInFailed = signInFailed;
  if (!signedIn && sessionEnded) status.sessionEnded = true;
  return status;
}

export function gateStateFromStatus(status: SignInStatus | null): GateState {
  if (!status) return 'checking';
  return status.signedIn ? 'signed-in' : 'signed-out';
}

const authorizePayload = z.object({ authorizeUrl: z.string() });

// The authorize URL goes straight to a browser, so only a web address passes.
export function parseAuthorizeUrl(payload: JsonValue): string | null {
  const parsed = authorizePayload.safeParse(payload);
  if (!parsed.success) return null;
  try {
    const url = new URL(parsed.data.authorizeUrl);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

// What the gate tells the person, most blocking first: no keychain means
// nothing here can help, and a damaged list must be repaired before any
// sign-in can be stored.
export function gateNotice(snapshot: GateSnapshot): GateNotice | null {
  const { status, checkFailed, actionFailed, waiting } = snapshot;
  if (status?.keychainMissing) return 'no-keychain';
  if (status?.accountsDamaged) return actionFailed === 'repair' ? 'repair-failed' : 'accounts-damaged';
  if (!status) return checkFailed ? 'check-failed' : null;
  if (actionFailed === 'start') return 'start-failed';
  if (waiting) return 'waiting';
  if (status.signInFailed === 'unreachable') return 'sign-in-unreachable';
  if (status.signInFailed === 'failed') return 'sign-in-failed';
  if (status.sessionEnded) return 'session-ended';
  return null;
}
