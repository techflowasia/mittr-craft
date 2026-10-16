import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loopbackPeersFromLsof, nonLoopbackFromLog, nonLoopbackFromLsof, policiesFor, quotaRefusal } from './probe-engine-v2.mjs';

test('policiesFor locks to one provider', () => {
  assert.deepEqual(policiesFor({ showOtherProviders: false, providerId: 'mittr' }), [
    { action: 'provider.use', resource: '*', effect: 'deny' },
    { action: 'provider.use', resource: 'mittr', effect: 'allow' },
  ]);
  assert.deepEqual(policiesFor({ showOtherProviders: true, providerId: 'mittr' }), []);
});

test('quotaRefusal carries the no-retry header', () => {
  const refusal = quotaRefusal({ kind: 'weekly', resetsAt: '2026-10-20T00:00:00+07:00' });
  assert.equal(refusal.status, 402);
  assert.equal(refusal.headers['x-should-retry'], 'false');
  assert.equal(refusal.body.error.code, 'llm_quota_exhausted');
  assert.equal(refusal.body.error.type, 'insufficient_quota');
  assert.equal(refusal.body.error.resets_at, '2026-10-19T17:00:00.000Z');
});

test('outbound parsers keep only non-loopback peers', () => {
  const lsof = [
    'COMMAND  PID USER FD TYPE DEVICE SIZE/OFF NODE NAME',
    'opencode 1 u 20u IPv4 0x1 0t0 TCP 127.0.0.1:50000 (LISTEN)',
    'opencode 1 u 21u IPv4 0x2 0t0 TCP 127.0.0.1:50001->127.0.0.1:11434 (ESTABLISHED)',
    'opencode 1 u 22u IPv4 0x3 0t0 TCP 192.168.1.5:50002->104.18.2.3:443 (ESTABLISHED)',
    'opencode 1 u 23u IPv6 0x4 0t0 TCP [::1]:50003->[::1]:8080 (ESTABLISHED)',
  ].join('\n');
  assert.deepEqual(nonLoopbackFromLsof(lsof), ['104.18.2.3:443']);
  assert.deepEqual(loopbackPeersFromLsof(lsof), ['50001->11434', '50003->8080']);
  assert.deepEqual(nonLoopbackFromLog('GET http://127.0.0.1:4096/v1 then https://models.dev/api.json and http://localhost:1'), ['models.dev']);
});
