import { describe, expect, it } from 'vitest';
import { assertLoopbackHost } from './loopback-guard.js';

describe('assertLoopbackHost', () => {
  it.each(['127.0.0.1', '::1', 'localhost'])('accepts %s', (host) => {
    expect(() => assertLoopbackHost(host)).not.toThrow();
  });

  it.each(['0.0.0.0', '::', '192.168.1.10', 'mittr.asia', ''])('rejects %s', (host) => {
    expect(() => assertLoopbackHost(host)).toThrow(/loopback/);
  });

  it('rejects a host that merely looks loopback', () => {
    expect(() => assertLoopbackHost('127.0.0.1.evil.example')).toThrow(/loopback/);
  });
});
