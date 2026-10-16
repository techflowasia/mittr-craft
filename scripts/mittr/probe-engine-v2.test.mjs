import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  failuresOf,
  HARNESS_SENTENCE,
  harnessReplacement,
  identityPluginSource,
  loopbackPeersFromLsof,
  nonLoopbackFromLog,
  nonLoopbackFromLsof,
  openCodeMentions,
  quotaRefusal,
  refusedByPolicy,
  stopConditionFor,
} from './probe-engine-v2.mjs';

test('refusedByPolicy needs an unanswered turn that failed with provider.no-route', () => {
  const noRoute = { type: 'session.execution.failed', error: { type: 'provider.no-route' } };
  assert.equal(refusedByPolicy({ answered: false, events: [{ type: 'session.created' }, noRoute] }), true);
  assert.equal(refusedByPolicy({ answered: false, events: [{ type: 'session.execution.failed', error: { type: 'provider.auth' } }] }), false);
  assert.equal(refusedByPolicy({ answered: true, events: [noRoute] }), false);
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

test('openCodeMentions counts the name, not paths', () => {
  assert.equal(openCodeMentions('You are an AI agent running in OpenCode. Read .opencode/agents and ~/opencode/x. opencode tools.'), 2);
});

test('the identity source rewrites the 2.0.22 harness sentence', async () => {
  const plugin = (await import(`data:text/javascript,${encodeURIComponent(identityPluginSource({ productName: 'MittrCraft' }))}`)).default;
  const hooks = {};
  await plugin.setup({ session: { hook: async (name, fn) => { hooks[name] = fn; } } });
  const o = { system: [{ type: 'text', text: `${HARNESS_SENTENCE} Use .opencode/agents.` }] };
  hooks.context(o);
  assert.deepEqual(Object.keys(hooks), ['context', 'generate', 'compaction']);
  assert.ok(o.system[0].text.startsWith(harnessReplacement('MittrCraft')));
  assert.ok(o.system[0].text.includes('.opencode/agents'));
  assert.equal(o.system.length, 2);
  assert.match(o.system[1].text, /answer MittrCraft/);
});

test('stop conditions map to the plan', () => {
  assert.deepEqual(stopConditionFor('P4', { pass: true }), { action: 'none', stop: false });
  assert.equal(stopConditionFor('P4', { pass: false }).stop, true);
  assert.equal(stopConditionFor('P3', { pass: false }).stop, true);
  assert.equal(stopConditionFor('P2', { pass: false, fallbackPass: true }).stop, false);
  assert.equal(stopConditionFor('P2b', { pass: false, fallbackPass: false }).stop, true);
  assert.equal(stopConditionFor('P5', { pass: false }).stop, false);
  assert.equal(stopConditionFor('P6', { pass: false }).stop, false);
  assert.equal(stopConditionFor('P7', { pass: false }).stop, true);
});

test('failuresOf flags missing verdicts and egress', () => {
  const outbound = { nonLoopbackRemotes: [], nonLoopbackHostsInLog: [], proxyNonLoopback: ['models.dev:443'] };
  const failures = failuresOf({ scenarios: { P1: { pass: true } }, outbound });
  assert.ok(failures.includes('P2: no verdict'));
  assert.ok(failures.includes('outbound: proxy models.dev:443'));
  assert.ok(failuresOf({ fatal: 'x', scenarios: {}, outbound }).includes('fatal'));
  assert.deepEqual(failuresOf({ scenarios: { P7: { pass: true } }, outbound: { ...outbound, proxyNonLoopback: [] } }, ['P7']), []);
});
