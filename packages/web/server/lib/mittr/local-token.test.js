import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureLocalToken } from './local-token.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-token-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ensureLocalToken', () => {
  it('creates a token on first call', () => {
    const token = ensureLocalToken({ tokenPath: path.join(dir, 'shim-token') });
    expect(token).toMatch(/^mc_local_[0-9a-f]{64}$/);
  });

  it('returns the same token on the next call', () => {
    const tokenPath = path.join(dir, 'shim-token');
    expect(ensureLocalToken({ tokenPath })).toBe(ensureLocalToken({ tokenPath }));
  });

  it('writes the file owner-readable only', () => {
    const tokenPath = path.join(dir, 'shim-token');
    ensureLocalToken({ tokenPath });
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it('replaces a corrupted token file instead of failing', () => {
    const tokenPath = path.join(dir, 'shim-token');
    fs.writeFileSync(tokenPath, 'not-a-token');
    expect(ensureLocalToken({ tokenPath })).toMatch(/^mc_local_/);
  });
});
