import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FIXTURE_RATE, SILENCE_SECONDS, fixtureList, makeFixtures, pcm16Of, wavFile } from './voice-fixtures.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p4f.'));

const fakeAfconvert = (seconds) => (command, args) => {
  if (command.endsWith('say')) {
    fs.writeFileSync(args[args.indexOf('-o') + 1], 'aiff');
    return;
  }
  const out = args.at(-1);
  const samples = Buffer.alloc(Math.round(seconds * FIXTURE_RATE) * 2);
  for (let i = 0; i < samples.length / 2; i += 1) samples.writeInt16LE(i % 200, i * 2);
  const fllr = Buffer.alloc(12);
  fllr.write('FLLR', 0);
  fllr.writeUInt32LE(4, 4);
  const plain = wavFile(samples, FIXTURE_RATE);
  fs.writeFileSync(out, Buffer.concat([plain.subarray(0, 36), fllr, plain.subarray(36)]));
};

test('a WAV round-trips through its PCM, past chunks it does not know', () => {
  const pcm = Buffer.from([1, 0, 2, 0, 3, 0]);
  const wav = wavFile(pcm, 16000);
  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt16LE(34), 16);
  const extra = Buffer.alloc(12);
  extra.write('LIST', 0);
  extra.writeUInt32LE(4, 4);
  const padded = Buffer.concat([wav.subarray(0, 36), extra, wav.subarray(36)]);
  assert.deepEqual(pcm16Of(padded), { rate: 16000, channels: 1, bits: 16, pcm });
});

test('each fixture is the speech followed by 25 s of digital silence, and the map holds its sha256 and transcript', () => {
  const out = tempDir();
  try {
    const map = makeFixtures(out, { pagesUrl: 'http://127.0.0.1:9', run: fakeAfconvert(1.5), voices: ['Samantha', 'Kanya'] });
    assert.equal(map.thaiVoice, 'Kanya');
    assert.deepEqual(map.fixtures.map((f) => f.name), fixtureList({ pagesUrl: 'http://127.0.0.1:9' }).map((f) => f.name));
    const sessions = map.fixtures.find((f) => f.name === 'sessions-en');
    assert.equal(sessions.transcript, 'what sessions are running');
    const bytes = fs.readFileSync(sessions.file);
    assert.equal(sessions.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    const { rate, channels, pcm } = pcm16Of(bytes);
    assert.equal(rate, 16000);
    assert.equal(channels, 1);
    assert.equal(pcm.length, Math.round((1.5 + SILENCE_SECONDS) * 16000) * 2);
    assert.ok(pcm.subarray(Math.round(1.5 * 16000) * 2).every((b) => b === 0));
    assert.equal(sessions.speechSeconds, 1.5);
    assert.ok(map.fixtures.find((f) => f.name === 'chrome-en').transcript.includes('http://127.0.0.1:9/form'));
    assert.equal(map.fixtures.find((f) => f.name === 'carry-on-th').voice, 'Kanya');
    assert.ok(fs.existsSync(path.join(out, 'fixtures.json')));
    assert.equal(fs.readdirSync(out).some((name) => name.endsWith('.aiff')), false);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('without the Thai voice the Thai rows use English speech and say so', () => {
  const out = tempDir();
  try {
    const map = makeFixtures(out, { pagesUrl: 'http://127.0.0.1:9', run: fakeAfconvert(0.5), voices: ['Samantha'] });
    assert.equal(map.thaiVoice, null);
    const thai = map.fixtures.find((f) => f.name === 'carry-on-th');
    assert.equal(thai.voice, 'Samantha');
    assert.equal(thai.englishSpeech, true);
    assert.match(thai.transcript, /^ทำต่อ/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('fixtures are never written inside the repository', () => {
  assert.throws(() => makeFixtures(path.join(REPO, 'scripts', 'mittr', 'p4f-never'), { run: fakeAfconvert(0.1), voices: ['Samantha'] }), /outside the repository/);
  assert.equal(fs.existsSync(path.join(REPO, 'scripts', 'mittr', 'p4f-never')), false);
});

const hasSay = process.platform === 'darwin' && fs.existsSync('/usr/bin/say') && fs.existsSync('/usr/bin/afconvert');

test('the real say and afconvert make a 16 kHz mono fixture', { skip: !hasSay }, () => {
  const out = tempDir();
  try {
    const voices = execFileSync('/usr/bin/say', ['-v', '?'], { encoding: 'utf8' }).split('\n').map((line) => line.split(/\s{2,}/)[0].trim()).filter(Boolean);
    const map = makeFixtures(out, { pagesUrl: 'http://127.0.0.1:9', voices, only: ['yes-en'] });
    const [yes] = map.fixtures;
    const { rate, channels, bits, pcm } = pcm16Of(fs.readFileSync(yes.file));
    assert.deepEqual([rate, channels, bits], [16000, 1, 16]);
    assert.ok(yes.speechSeconds > 0.1 && yes.speechSeconds < 5);
    assert.equal(pcm.length, yes.speechSamples * 2 + SILENCE_SECONDS * 16000 * 2);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
