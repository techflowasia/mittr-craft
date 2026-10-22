#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

export const FIXTURE_RATE = 16000;
export const SILENCE_SECONDS = 25;
export const ENGLISH_VOICE = 'Samantha';
export const THAI_VOICE = 'Kanya';

export const fixtureList = ({ pagesUrl = 'http://127.0.0.1:9' } = {}) => [
  { name: 'sessions-en', lang: 'en', transcript: 'what sessions are running' },
  { name: 'send-en', lang: 'en', transcript: "send 'add a README' to the newest session", spoken: 'send add a README to the newest session' },
  { name: 'read-en', lang: 'en', transcript: 'what did it answer' },
  { name: 'stop-en', lang: 'en', transcript: 'stop the newest session' },
  { name: 'yes-en', lang: 'en', transcript: 'yes' },
  { name: 'chrome-en', lang: 'en', transcript: `open ${pagesUrl}/form in Chrome and tell me the heading`, spoken: 'open the stub form in Chrome and tell me the heading' },
  { name: 'end-en', lang: 'en', transcript: 'end the conversation' },
  { name: 'bye-en', lang: 'en', transcript: 'bye' },
  { name: 'carry-on-th', lang: 'th', transcript: 'ทำต่อเลย ดูทุกเซสชันให้หน่อย', englishSpoken: 'carry on and look at every session' },
];

export const wavFile = (pcm, rate = FIXTURE_RATE) => {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
};

export const pcm16Of = (bytes) => {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let at = 12;
  let format = null;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === 'fmt ') format = { channels: bytes.readUInt16LE(at + 10), rate: bytes.readUInt32LE(at + 12), bits: bytes.readUInt16LE(at + 22) };
    if (id === 'data') {
      if (!format) throw new Error('WAV data before its format');
      return { ...format, pcm: Buffer.from(bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + size))) };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('WAV without data');
};

const insideRepo = (dir) => {
  const relative = path.relative(REPO, path.resolve(dir));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const runFile = (command, args) => {
  execFileSync(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
};

export const installedVoices = () => execFileSync('/usr/bin/say', ['-v', '?'], { encoding: 'utf8' })
  .split('\n').map((line) => line.split(/\s{2,}/)[0].trim()).filter(Boolean);

export const makeFixtures = (out, { pagesUrl, run = runFile, voices = installedVoices(), only = null } = {}) => {
  if (insideRepo(out)) throw new Error('fixtures are made outside the repository only');
  fs.mkdirSync(out, { recursive: true });
  const thaiVoice = voices.includes(THAI_VOICE) ? THAI_VOICE : null;
  const fixtures = [];
  for (const entry of fixtureList({ pagesUrl })) {
    if (only && !only.includes(entry.name)) continue;
    const englishSpeech = entry.lang === 'th' && !thaiVoice;
    const voice = entry.lang === 'th' && thaiVoice ? thaiVoice : ENGLISH_VOICE;
    const words = englishSpeech ? entry.englishSpoken : (entry.spoken ?? entry.transcript);
    const aiff = path.join(out, `${entry.name}.aiff`);
    const converted = path.join(out, `${entry.name}.raw.wav`);
    const file = path.join(out, `${entry.name}.wav`);
    try {
      run('/usr/bin/say', ['-v', voice, '-o', aiff, words]);
      run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', `LEI16@${FIXTURE_RATE}`, '-c', '1', aiff, converted]);
      const { rate, channels, bits, pcm } = pcm16Of(fs.readFileSync(converted));
      if (rate !== FIXTURE_RATE || channels !== 1 || bits !== 16) throw new Error(`${entry.name}: afconvert gave ${rate} Hz, ${channels} channels, ${bits} bits`);
      const speech = Buffer.from(pcm.subarray(0, pcm.length & ~1));
      const wav = wavFile(Buffer.concat([speech, Buffer.alloc(SILENCE_SECONDS * FIXTURE_RATE * 2)]));
      fs.writeFileSync(file, wav);
      const speechSamples = speech.length / 2;
      fixtures.push({
        name: entry.name,
        lang: entry.lang,
        voice,
        englishSpeech,
        file,
        transcript: entry.transcript,
        sha256: crypto.createHash('sha256').update(wav).digest('hex'),
        speechSamples,
        speechSeconds: Math.round((speechSamples / FIXTURE_RATE) * 1000) / 1000,
      });
    } finally {
      fs.rmSync(aiff, { force: true });
      fs.rmSync(converted, { force: true });
    }
  }
  const map = { rate: FIXTURE_RATE, silenceSeconds: SILENCE_SECONDS, thaiVoice, fixtures };
  fs.writeFileSync(path.join(out, 'fixtures.json'), `${JSON.stringify(map, null, 2)}\n`);
  return map;
};

const argValue = (argv, flag, fallback = null) => {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : argv[index + 1] ?? fallback;
};

const main = () => {
  const argv = process.argv.slice(2);
  const out = argValue(argv, '--out');
  if (!out) throw new Error('usage: voice-fixtures.mjs --out <dir outside the repository> [--pages <url>]');
  const map = makeFixtures(out, { pagesUrl: argValue(argv, '--pages', 'http://127.0.0.1:9') });
  process.stdout.write(`${map.fixtures.length} fixtures, Thai voice ${map.thaiVoice ?? 'missing (English speech)'}\n`);
  for (const fixture of map.fixtures) process.stdout.write(`${fixture.name} ${fixture.sha256} ${fixture.speechSeconds}s\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
