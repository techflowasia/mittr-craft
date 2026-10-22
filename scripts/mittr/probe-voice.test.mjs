import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MARKER_TRANSCRIPT, maxGapOf, multipartFieldsOf, pcm16Tone, wavHeaderOf, wavOf } from './probe-voice.mjs';

test('a 16 kHz mono PCM16 WAV header is read', () => {
  const wav = wavOf(pcm16Tone({ rate: 16000, seconds: 0.25 }), 16000);
  assert.deepEqual(wavHeaderOf(wav), { rate: 16000, channels: 1, bits: 16 });
  assert.deepEqual(wavHeaderOf(wavOf(pcm16Tone({ rate: 24000, seconds: 0.1 }), 24000)), { rate: 24000, channels: 1, bits: 16 });
  assert.equal(wavHeaderOf(Buffer.from('not a wav file at all, just text')), null);
  assert.equal(wavHeaderOf(Buffer.alloc(4)), null);
});

test('multipart field names come out in order', () => {
  const boundary = '----probe-boundary-1';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nmittr\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    Buffer.from([0, 1, 2, 3]),
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n--${boundary}--\r\n`),
  ]);
  assert.deepEqual(multipartFieldsOf(body, `multipart/form-data; boundary=${boundary}`), [
    { name: 'model' },
    { name: 'file', filename: 'audio.wav', type: 'audio/wav' },
    { name: 'response_format' },
  ]);
  assert.deepEqual(multipartFieldsOf(body, 'application/json'), []);
});

test('the largest gap between scheduled chunks is found', () => {
  assert.equal(maxGapOf([]), 0);
  assert.equal(maxGapOf([{ startsAt: 2, endsAt: 5 }]), 0);
  assert.equal(maxGapOf([{ startsAt: 2, endsAt: 5 }, { startsAt: 5, endsAt: 9 }, { startsAt: 10.5, endsAt: 12 }]), 1.5);
  assert.equal(maxGapOf([{ startsAt: 6, endsAt: 8 }, { startsAt: 2, endsAt: 4 }]), 2);
  assert.equal(maxGapOf([{ startsAt: 2, endsAt: 5 }, { startsAt: 4, endsAt: 6 }]), 0);
});

test('the marker transcript is the one the stub answers', () => {
  assert.equal(MARKER_TRANSCRIPT, 'probe heard you');
});
