import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSession, createSessionStore } from './session.js';

const valid = {
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  expiresAt: 1_800_000,
  subject: { userId: 'u1', displayName: 'Chaiwat' },
};

describe('parseSession', () => {
  it('accepts a well-formed payload and returns only known fields', () => {
    expect(parseSession({ ...valid, serverSecret: 'must not survive' })).toEqual(valid);
  });

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['no access token', { ...valid, accessToken: '' }],
    ['no refresh token', { ...valid, refreshToken: undefined }],
    ['a non-numeric expiry', { ...valid, expiresAt: 'soon' }],
    ['no subject', { ...valid, subject: undefined }],
    ['a subject with no user id', { ...valid, subject: { displayName: 'x' } }],
  ])('rejects %s', (_label, payload) => {
    expect(() => parseSession(payload)).toThrow();
  });

  it('tolerates a missing display name, which is cosmetic', () => {
    expect(parseSession({ ...valid, subject: { userId: 'u1' } }).subject.displayName).toBe('');
  });
});

let dir;
// Stands in for Electron safeStorage. It has to actually obscure the bytes:
// a double that only prefixes the plaintext would let the "no plaintext on
// disk" test pass while proving nothing.
const encrypt = (text) => Buffer.from(Buffer.from(text, 'utf8').toString('base64'), 'utf8');
const decrypt = (buffer) => Buffer.from(Buffer.from(buffer).toString('utf8'), 'base64').toString('utf8');

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-session-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const store = () => createSessionStore({ filePath: path.join(dir, 'session'), encrypt, decrypt });

describe('session store', () => {
  it('has no session before anything is written', () => {
    expect(store().read()).toBeNull();
  });

  it('round-trips a session', () => {
    store().write(valid);
    expect(store().read()).toEqual(valid);
  });

  it('never writes the token in plaintext', () => {
    store().write(valid);
    expect(fs.readFileSync(path.join(dir, 'session')).toString('utf8')).not.toContain('at-1');
  });

  it('writes owner-readable only', () => {
    store().write(valid);
    expect(fs.statSync(path.join(dir, 'session')).mode & 0o777).toBe(0o600);
  });

  it('treats a session it cannot decrypt as no session, rather than crashing at startup', () => {
    fs.writeFileSync(path.join(dir, 'session'), 'garbage');
    const broken = createSessionStore({
      filePath: path.join(dir, 'session'),
      encrypt,
      decrypt: () => { throw new Error('cannot decrypt'); },
    });
    expect(broken.read()).toBeNull();
  });

  it('treats a decryptable but malformed session as no session', () => {
    fs.writeFileSync(path.join(dir, 'session'), encrypt(JSON.stringify({ accessToken: 'at-1' })));
    expect(store().read()).toBeNull();
  });

  it('refuses to write a payload that is not a session', () => {
    expect(() => store().write({ accessToken: 'at-1' })).toThrow();
    expect(fs.existsSync(path.join(dir, 'session'))).toBe(false);
  });

  it('clears the session', () => {
    const s = store();
    s.write(valid);
    s.clear();
    expect(s.read()).toBeNull();
  });
});
