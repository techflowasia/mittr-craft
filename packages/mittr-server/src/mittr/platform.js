import { STATUS_CODES } from 'node:http';

import { isRecord } from './values.js';

export const PLATFORM_TIMEOUT_MS = 15_000;
export const BROWSER_STEP_TIMEOUT_MS = 30_000;
export const CANNOT_REACH_MITTR = 'Cannot reach Mittr';
export const PLATFORM_TIMED_OUT = 'Mittr platform request timed out';
export const READ_FAILED = 'Could not read this week’s quota';
export const PLATFORM_CANCELLED = 'The Mittr platform request was cancelled';
export const ACCOUNT_CHANGED = 'The Mittr account changed';

const HTTP_REASONS = new Set(Object.values(STATUS_CODES).map((reason) => reason.toLowerCase()));

const textOf = (value) => (value?.constructor === String && value.trim() ? value : null);

export const platformErrorText = (body) => {
  if (!isRecord(body)) return null;
  const error = textOf(body.error);
  if (error && !HTTP_REASONS.has(error.trim().toLowerCase())) return error;
  return textOf(body.message);
};

export const isTimeout = (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError';

export const callPlatform = async (fetchImpl, url, { accessToken, method = 'GET', body, timeoutMs = PLATFORM_TIMEOUT_MS, signal } = {}) => {
  const headers = { authorization: `Bearer ${accessToken}` };
  if (body) headers['content-type'] = 'application/json';
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const reply = await response.json().catch((error) => {
      if (isTimeout(error)) throw error;
      return null;
    });
    return { response, body: reply };
  } catch (error) {
    if (signal?.aborted) return { failure: { status: 499, error: PLATFORM_CANCELLED } };
    if (isTimeout(error)) return { failure: { status: 504, error: PLATFORM_TIMED_OUT } };
    return { failure: { status: 502, error: CANNOT_REACH_MITTR }, cause: error };
  }
};
