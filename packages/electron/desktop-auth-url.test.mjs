import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDesktopAuthUrl } from './desktop-auth-url.mjs';

const handoffId = 'h'.repeat(43);
const challenge = 'c'.repeat(43);
const allowedOrigins = new Set(['https://chamber.example.com']);

test('accepts a Desktop Entra handoff on a configured origin', () => {
  const result = validateDesktopAuthUrl(
    `https://chamber.example.com/auth/ad/login?desktopHandoff=${handoffId}&desktopChallenge=${challenge}&trustDevice=true`,
    allowedOrigins,
  );
  assert.equal(new URL(result).origin, 'https://chamber.example.com');
});

test('rejects unconfigured origins and non-authentication paths', () => {
  assert.throws(() => validateDesktopAuthUrl(
    `https://attacker.example/auth/ad/login?desktopHandoff=${handoffId}&desktopChallenge=${challenge}`,
    allowedOrigins,
  ), /origin is not configured/);
  assert.throws(() => validateDesktopAuthUrl(
    `https://chamber.example.com/settings?desktopHandoff=${handoffId}&desktopChallenge=${challenge}`,
    allowedOrigins,
  ), /not allowed/);
});

test('rejects malformed or expanded authentication requests', () => {
  assert.throws(() => validateDesktopAuthUrl(
    `https://chamber.example.com/auth/ad/login?desktopHandoff=short&desktopChallenge=${challenge}`,
    allowedOrigins,
  ), /handoff is invalid/);
  assert.throws(() => validateDesktopAuthUrl(
    `https://chamber.example.com/auth/ad/login?desktopHandoff=${handoffId}&desktopChallenge=${challenge}&returnTo=https://attacker.example`,
    allowedOrigins,
  ), /unsupported parameters/);
});
