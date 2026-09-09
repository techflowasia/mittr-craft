import { describe, expect, it } from 'vitest';
import { createTransaction, verifyCallback } from './sign-in-transaction.js';

const txAt = (ms) => createTransaction({ now: () => ms });

describe('sign-in transaction', () => {
  it('produces a verifier and a challenge derived from it', () => {
    const tx = txAt(0);
    expect(tx.verifier).toMatch(/^[0-9a-f]{64}$/);
    expect(tx.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('gives every transaction its own verifier', () => {
    expect(txAt(0).verifier).not.toBe(txAt(0).verifier);
  });

  it('accepts a callback carrying a code', () => {
    const tx = txAt(0);
    expect(verifyCallback(tx, 'mittrcraft://auth/callback?code=abc123', { now: () => 1000 }))
      .toEqual({ code: 'abc123' });
  });

  it('rejects a callback with no code', () => {
    expect(() => verifyCallback(txAt(0), 'mittrcraft://auth/callback', { now: () => 1000 }))
      .toThrow(/code/i);
  });

  it('rejects a callback on another scheme or host', () => {
    const tx = txAt(0);
    expect(() => verifyCallback(tx, 'https://evil.test/callback?code=x', { now: () => 1 }))
      .toThrow(/callback/i);
    expect(() => verifyCallback(tx, 'mittrcraft://connect/callback?code=x', { now: () => 1 }))
      .toThrow(/callback/i);
  });

  it('rejects a callback that arrives after the transaction expires', () => {
    expect(() => verifyCallback(txAt(0), 'mittrcraft://auth/callback?code=abc', { now: () => 10 * 60 * 1000 + 1 }))
      .toThrow(/expired/i);
  });

  it('rejects a callback when no sign-in is pending', () => {
    expect(() => verifyCallback(null, 'mittrcraft://auth/callback?code=abc', { now: () => 1 }))
      .toThrow(/no sign-in/i);
  });

  it('rejects a malformed url instead of throwing something unreadable', () => {
    expect(() => verifyCallback(txAt(0), 'not a url', { now: () => 1 })).toThrow(/valid url/i);
  });
});
