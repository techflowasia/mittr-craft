import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { tempDataDir } from '../test-helpers.js';
import { SPEECH_KEY_PREFIX, VOICE_KEYS_FILE, createSpeechKeys, mintSpeechKey } from './speech-key.js';

const fileOf = (dataDir) => path.join(dataDir, VOICE_KEYS_FILE);
const readKeys = (dataDir) => JSON.parse(fs.readFileSync(fileOf(dataDir), 'utf8'));
const writeKeys = (dataDir, keys) => fs.writeFileSync(fileOf(dataDir), JSON.stringify(keys), { mode: 0o600 });
const modeOf = (file) => fs.statSync(file).mode & 0o777;

test('a speech key is mc_speech_ and 64 hex, new each time', () => {
  assert.equal(SPEECH_KEY_PREFIX, 'mc_speech_');
  assert.equal(VOICE_KEYS_FILE, 'voice-keys.json');
  const first = mintSpeechKey();
  assert.match(first, /^mc_speech_[0-9a-f]{64}$/);
  assert.notEqual(mintSpeechKey(), first);
});

test('the key matches only itself, as a bearer', (t) => {
  const keys = createSpeechKeys({ dataDir: tempDataDir(t) });
  assert.equal(keys.matches(keys.current()), true);
  for (const other of ['', ' ', `${keys.current()}x`, keys.current().slice(0, -1), mintSpeechKey(), null, undefined]) {
    assert.equal(keys.matches(other), false, String(other));
  }
});

test('the speech key is written only for the kinds asked, mode 600, and another kind\'s key is kept', { skip: process.platform === 'win32' }, (t) => {
  const dataDir = tempDataDir(t);
  writeKeys(dataDir, { openai: 'sk-person-own', openaiCompatible: 'person-server-key' });
  const keys = createSpeechKeys({ dataDir });

  keys.install(['stt']);
  assert.deepEqual(readKeys(dataDir), { openai: 'sk-person-own', openaiCompatible: 'person-server-key', stt: keys.current() });
  assert.equal(modeOf(fileOf(dataDir)), 0o600);
  assert.deepEqual(keys.installed(), { stt: true, openaiCompatible: false });
  assert.deepEqual(fs.readdirSync(dataDir), [VOICE_KEYS_FILE]);

  keys.install(['openaiCompatible']);
  assert.deepEqual(readKeys(dataDir), { openai: 'sk-person-own', openaiCompatible: keys.current(), stt: keys.current() });
  assert.deepEqual(keys.installed(), { stt: true, openaiCompatible: true });
});

test('a restart replaces our key and leaves the person\'s own', (t) => {
  const dataDir = tempDataDir(t);
  const before = createSpeechKeys({ dataDir });
  before.install(['stt']);
  writeKeys(dataDir, { ...readKeys(dataDir), openaiCompatible: 'person-server-key' });

  const after = createSpeechKeys({ dataDir });
  assert.deepEqual(after.installed(), { stt: false, openaiCompatible: false });
  after.refreshInstalled();
  assert.deepEqual(readKeys(dataDir), { stt: after.current(), openaiCompatible: 'person-server-key' });
  assert.deepEqual(after.installed(), { stt: true, openaiCompatible: false });
  assert.notEqual(after.current(), before.current());
});

test('removing a kind that holds the person\'s own key changes nothing', (t) => {
  const dataDir = tempDataDir(t);
  writeKeys(dataDir, { stt: 'person-stt-key' });
  const keys = createSpeechKeys({ dataDir });
  keys.remove('stt');
  assert.deepEqual(readKeys(dataDir), { stt: 'person-stt-key' });

  keys.install(['openaiCompatible']);
  keys.remove('openaiCompatible');
  assert.deepEqual(readKeys(dataDir), { stt: 'person-stt-key' });
});

test('a key the person saves in Settings at the same time is kept', (t) => {
  const dataDir = tempDataDir(t);
  const keys = createSpeechKeys({ dataDir });
  keys.install(['stt']);
  writeKeys(dataDir, { ...readKeys(dataDir), openai: 'sk-saved-meanwhile' });
  keys.install(['openaiCompatible']);
  keys.remove('stt');
  assert.deepEqual(readKeys(dataDir), { openai: 'sk-saved-meanwhile', openaiCompatible: keys.current() });
});

test('a key file that is not JSON is never overwritten', (t) => {
  const dataDir = tempDataDir(t);
  fs.writeFileSync(fileOf(dataDir), '{ not json', { mode: 0o600 });
  const keys = createSpeechKeys({ dataDir });
  assert.throws(() => keys.install(['stt']), /voice-keys\.json/);
  assert.equal(fs.readFileSync(fileOf(dataDir), 'utf8'), '{ not json');
  assert.deepEqual(keys.installed(), { stt: false, openaiCompatible: false });
});

test('with no key file, nothing to refresh writes nothing', (t) => {
  const dataDir = tempDataDir(t);
  const keys = createSpeechKeys({ dataDir });
  keys.refreshInstalled();
  keys.remove('stt');
  assert.deepEqual(fs.readdirSync(dataDir), []);
});
