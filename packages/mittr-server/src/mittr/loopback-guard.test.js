import assert from 'node:assert/strict';
import test from 'node:test';

import { cameThroughProxy, isLoopbackPeer } from './loopback-guard.js';

test('the loopback addresses a local socket reports are loopback peers', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackPeer(address), true, address);
});

test('anything else is not', () => {
  for (const address of ['10.0.0.5', '192.168.1.2', '::ffff:10.0.0.5', 'fe80::1', '0.0.0.0', 'localhost', '', undefined, null]) {
    assert.equal(isLoopbackPeer(address), false, String(address));
  }
});

test('a request a tunnel or proxy relayed is recognised by its forwarding headers', () => {
  assert.equal(cameThroughProxy({ 'content-type': 'application/json', 'x-opencode-session-id': 'ses_1' }), false);
  for (const header of ['forwarded', 'x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'x-openchamber-relay-connection']) {
    assert.equal(cameThroughProxy({ [header]: '203.0.113.9' }), true, header);
  }
});
