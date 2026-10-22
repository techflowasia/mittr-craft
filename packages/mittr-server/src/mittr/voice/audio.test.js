import assert from 'node:assert/strict';
import test from 'node:test';

import { PCM_DEFAULT_RATE, SPEECH_TEXT_MAX_CHARS, pcm16ToWav, pcmFormatOf, splitSpeechText } from './audio.js';

const wavHeaderOf = (wav) => ({
  riff: wav.toString('ascii', 0, 4),
  wave: wav.toString('ascii', 8, 12),
  format: wav.readUInt16LE(20),
  channels: wav.readUInt16LE(22),
  rate: wav.readUInt32LE(24),
  byteRate: wav.readUInt32LE(28),
  bits: wav.readUInt16LE(34),
  data: wav.readUInt32LE(40),
});

const lettersOf = (parts) => parts.join('').replace(/\s/g, '');

test('PCM is wrapped as a mono 16-bit WAV at its rate', () => {
  const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
  const wav = pcm16ToWav(pcm, 24000);
  assert.deepEqual(wavHeaderOf(wav), { riff: 'RIFF', wave: 'WAVE', format: 1, channels: 1, rate: 24000, byteRate: 48000, bits: 16, data: 8 });
  assert.deepEqual(wav.subarray(44), pcm);
});

test('pcmFormatOf reads audio/pcm and audio/l16, with 24 kHz mono by default', () => {
  assert.equal(PCM_DEFAULT_RATE, 24000);
  assert.deepEqual(pcmFormatOf('audio/pcm'), { rate: 24000, channels: 1, swap: false });
  assert.deepEqual(pcmFormatOf('audio/pcm;rate=16000'), { rate: 16000, channels: 1, swap: false });
  assert.deepEqual(pcmFormatOf('audio/L16; rate=22050; channels=2'), { rate: 22050, channels: 2, swap: true });
  for (const type of ['audio/wav', 'audio/mpeg', 'application/json', '', null, undefined]) assert.equal(pcmFormatOf(type), null, String(type));
});

test('a text up to the limit is one part, and an empty one none', () => {
  assert.equal(SPEECH_TEXT_MAX_CHARS, 4000);
  assert.deepEqual(splitSpeechText('Hello there.'), ['Hello there.']);
  assert.deepEqual(splitSpeechText('a'.repeat(4000)), ['a'.repeat(4000)]);
  assert.deepEqual(splitSpeechText('   '), []);
});

test('6000 characters of sentences are cut after the last sentence end before the limit', () => {
  const sentence = 'This is one sentence of the answer. ';
  const text = sentence.repeat(Math.ceil(6000 / sentence.length)).trim();
  const parts = splitSpeechText(text);
  assert.equal(parts.length, 2);
  for (const part of parts) assert.ok(part.length <= 4000);
  assert.ok(parts[0].endsWith('.'));
  assert.equal(lettersOf(parts), lettersOf([text]));
});

test('a Thai full stop, a question, an ellipsis and a newline each end a sentence', () => {
  for (const end of ['。', '?', '!', '…', '\n']) {
    const text = `${'ก'.repeat(3000)}${end}${'ข'.repeat(2000)}`;
    const parts = splitSpeechText(text);
    assert.equal(parts.length, 2, JSON.stringify(end));
    assert.equal(parts[1], 'ข'.repeat(2000));
  }
});

test('a 4200-character sentence is split at whitespace and nothing is dropped', () => {
  const words = Array.from({ length: 720 }, (_, index) => `คำ${index % 10}xy`);
  const text = words.join(' ');
  assert.ok(text.length > 4200);
  const parts = splitSpeechText(text);
  assert.equal(parts.length, 2);
  for (const part of parts) assert.ok(part.length <= 4000);
  assert.equal(parts.join(' '), text);
});

test('a text with no break is cut at the limit, never inside a surrogate pair', () => {
  const plain = 'x'.repeat(9000);
  assert.deepEqual(splitSpeechText(plain).map((part) => part.length), [4000, 4000, 1000]);

  const emoji = `${'x'.repeat(3999)}😀${'y'.repeat(10)}`;
  const parts = splitSpeechText(emoji);
  assert.deepEqual(parts, ['x'.repeat(3999), `😀${'y'.repeat(10)}`]);
  assert.equal(parts.join(''), emoji);
});
