import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccountStore } from './account-store.js';

const encrypt = (text) => Buffer.from(Buffer.from(text, 'utf8').toString('base64'), 'utf8');
const decrypt = (buffer) => Buffer.from(Buffer.from(buffer).toString('utf8'), 'base64').toString('utf8');

const sessionFor = (userId, displayName, token = `at-${userId}`) => ({
  accessToken: token,
  refreshToken: `rt-${userId}`,
  expiresAt: 1_800_000,
  subject: { userId, displayName },
});

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-accounts-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const store = () => createAccountStore({ dataDir: dir, encrypt, decrypt });

describe('account store', () => {
  it('has no account and no session before anyone signs in', () => {
    expect(store().read()).toBeNull();
    expect(store().list()).toEqual([]);
    expect(store().activeHome()).toBeNull();
  });

  it('keeps a second account beside the first and makes the newest one active', () => {
    store().write(sessionFor('u1', 'Chaiwat'));
    store().write(sessionFor('u2', 'Chaiwat (test)'));

    expect(store().read().subject.userId).toBe('u2');
    expect(store().list()).toEqual([
      { userId: 'u1', displayName: 'Chaiwat', active: false },
      { userId: 'u2', displayName: 'Chaiwat (test)', active: true },
    ]);
  });

  it('switches between signed-in accounts without signing either out', () => {
    store().write(sessionFor('u1', 'Chaiwat'));
    store().write(sessionFor('u2', 'Chaiwat (test)'));

    store().activate('u1');

    expect(store().read().accessToken).toBe('at-u1');
    expect(store().list().map((account) => account.userId)).toEqual(['u1', 'u2']);
  });

  it('refuses to activate an account that is not signed in', () => {
    store().write(sessionFor('u1', 'Chaiwat'));
    expect(() => store().activate('nobody')).toThrow();
    expect(store().read().subject.userId).toBe('u1');
  });

  it('signing in again as a known account refreshes it instead of adding a copy', () => {
    store().write(sessionFor('u1', 'Chaiwat'));
    store().write(sessionFor('u1', 'Chaiwat Tan', 'at-new'));

    expect(store().list()).toEqual([{ userId: 'u1', displayName: 'Chaiwat Tan', active: true }]);
    expect(store().read().accessToken).toBe('at-new');
  });

  it('gives the first account the existing history and every later one a home of its own', () => {
    store().write(sessionFor('u1', 'Chaiwat'));
    expect(store().activeHome()).toBeNull();

    store().write(sessionFor('u2', 'Chaiwat (test)'));
    const second = store().activeHome();
    expect(second).toMatch(/^[0-9a-f]{16}$/);

    store().activate('u1');
    expect(store().activeHome()).toBeNull();
    store().activate('u2');
    expect(store().activeHome()).toBe(second);
  });

  it('signing out the active account moves to the one left and keeps its home for a later sign-in', () => {
    store().write(sessionFor('u1', 'Chaiwat'));
    store().write(sessionFor('u2', 'Chaiwat (test)'));
    const home = store().activeHome();

    store().clear();

    expect(store().read().subject.userId).toBe('u1');
    expect(store().list()).toEqual([{ userId: 'u1', displayName: 'Chaiwat', active: true }]);

    store().write(sessionFor('u2', 'Chaiwat (test)'));
    expect(store().activeHome()).toBe(home);
  });

  it('is signed out entirely once the last account leaves', () => {
    store().write(sessionFor('u1', 'Chaiwat'));
    store().clear();
    expect(store().read()).toBeNull();
    expect(store().list()).toEqual([]);
  });

  it('carries the single session an earlier version stored into the first account, once', () => {
    fs.writeFileSync(path.join(dir, 'mittr-session'), encrypt(JSON.stringify(sessionFor('u1', 'Chaiwat'))));

    expect(store().read().subject.userId).toBe('u1');
    expect(store().activeHome()).toBeNull();
    expect(fs.existsSync(path.join(dir, 'mittr-session'))).toBe(false);
  });

  it('never writes a token in plaintext', () => {
    store().write(sessionFor('u1', 'Chaiwat'));
    for (const name of fs.readdirSync(path.join(dir, 'mittr-accounts'))) {
      expect(fs.readFileSync(path.join(dir, 'mittr-accounts', name)).toString('utf8')).not.toContain('at-u1');
    }
  });

  it('treats an unreadable index as no accounts rather than crashing', () => {
    fs.mkdirSync(path.join(dir, 'mittr-accounts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'mittr-accounts', 'index.json'), 'garbage');
    expect(store().read()).toBeNull();
    expect(store().list()).toEqual([]);
  });
});
