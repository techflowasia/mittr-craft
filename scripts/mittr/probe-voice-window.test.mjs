import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cspOf, fakeAudioInputsOnly, launchArgsFor, tccLinesFor, tccSummaryOf } from './probe-voice-window.mjs';

test('only Chromium fake audio inputs let the probe ask for the microphone', () => {
  const fake = [
    { kind: 'audioinput', label: 'Fake Default Audio Input', deviceId: 'default' },
    { kind: 'audioinput', label: 'Fake Audio Input 1', deviceId: 'a' },
    { kind: 'videoinput', label: 'fake_device_0', deviceId: 'v' },
    { kind: 'audiooutput', label: 'Fake Audio Output 1', deviceId: 'o' },
  ];
  assert.deepEqual(fakeAudioInputsOnly(fake), { ok: true, audioInputs: ['Fake Default Audio Input', 'Fake Audio Input 1'] });
  assert.equal(fakeAudioInputsOnly([...fake, { kind: 'audioinput', label: 'MacBook Pro Microphone', deviceId: 'm' }]).ok, false);
  assert.equal(fakeAudioInputsOnly([{ kind: 'audioinput', label: '', deviceId: 'default' }]).ok, false);
  assert.equal(fakeAudioInputsOnly([]).ok, false);
  assert.equal(fakeAudioInputsOnly(null).ok, false);
});

test('every launch carries the fake media flags, the muted output and the DevTools port', () => {
  const args = launchArgsFor({ fixture: '/tmp/p4.x/fixture.wav', devtoolsPort: 51234 });
  for (const flag of [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--use-file-for-fake-audio-capture=/tmp/p4.x/fixture.wav',
    '--mute-audio',
    '--use-mock-keychain',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=51234',
  ]) assert.ok(args.includes(flag), flag);
  assert.throws(() => launchArgsFor({ fixture: 'relative.wav', devtoolsPort: 51234 }));
  assert.throws(() => launchArgsFor({ fixture: '/tmp/a,b.wav', devtoolsPort: 51234 }));
});

test('the TCC log is narrowed to the app bundle id', () => {
  const text = [
    '2026-10-22 12:00:00.1 Df tccd[1]: [com.apple.TCC:access] AUTHREQ_CTX: msgID=1, function=TCCAccessRequest, service=kTCCServiceMicrophone, preflight=yes, query=1, client_dict=(null), daemon_dict={identifier=dev.mittrcraft.desktop.dev.gate}',
    '2026-10-22 12:00:01.1 Df tccd[1]: [com.apple.TCC:access] AUTHREQ_CTX: service=kTCCServiceMicrophone identifier=com.google.Chrome',
    '2026-10-22 12:00:02.1 Df tccd[1]: [com.apple.TCC:access] identifier=dev.mittrcraft.desktop.dev.gate.helper',
  ].join('\n');
  const lines = tccLinesFor(text, 'dev.mittrcraft.desktop.dev.gate');
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.includes('dev.mittrcraft.desktop.dev.gate')));
  assert.deepEqual(tccLinesFor('', 'dev.mittrcraft.desktop.dev.gate'), []);
});

test('the main document CSP is read from the header and from any meta tag', () => {
  const html = '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\' \'wasm-unsafe-eval\'"></head></html>';
  assert.deepEqual(cspOf({ headers: { 'content-security-policy': "frame-ancestors 'self'" }, html }), {
    header: "frame-ancestors 'self'",
    meta: ["default-src 'self'; script-src 'self' 'wasm-unsafe-eval'"],
  });
  assert.deepEqual(cspOf({ headers: {}, html: '<html></html>' }), { header: null, meta: [] });
});

test('TCC lines are summarised by service and preflight', () => {
  const preflight = [
    'AUTHREQ_CTX: msgID=1.1, function=<private>, service=kTCCServiceListenEvent, preflight=yes, query=1',
    'AUTHREQ_CTX: msgID=2.1, function=<private>, service=kTCCServiceScreenCapture, preflight=yes, query=1',
  ];
  assert.deepEqual(tccSummaryOf(preflight), { lines: 2, services: ['kTCCServiceListenEvent', 'kTCCServiceScreenCapture'], microphone: false, preflightOnly: true });
  const asked = tccSummaryOf([...preflight, 'AUTHREQ_CTX: msgID=3.1, function=<private>, service=kTCCServiceMicrophone, preflight=no, query=1']);
  assert.equal(asked.microphone, true);
  assert.equal(asked.preflightOnly, false);
});
