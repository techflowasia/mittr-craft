import { STATUS_CODES } from 'node:http';

import { isRecord } from './values.js';

export const PLATFORM_TIMEOUT_MS = 15_000;
export const CANNOT_REACH_MITTR = 'Cannot reach Mittr';
export const PLATFORM_TIMED_OUT = 'Mittr platform request timed out';
export const READ_FAILED = 'Could not read this week’s quota';

const HTTP_REASONS = new Set(Object.values(STATUS_CODES).map((reason) => reason.toLowerCase()));

const textOf = (value) => (value?.constructor === String && value.trim() ? value : null);

export const platformErrorText = (body) => {
  if (!isRecord(body)) return null;
  const error = textOf(body.error);
  if (error && !HTTP_REASONS.has(error.trim().toLowerCase())) return error;
  return textOf(body.message);
};

export const isTimeout = (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError';
