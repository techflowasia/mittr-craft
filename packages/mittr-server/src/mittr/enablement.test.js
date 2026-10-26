import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createEnablementStore } from './enablement.js';
import { tempDataDir } from './test-helpers.js';

const fileIn = (dir) => path.join(dir, 'mittr-enablement.json');

test('nothing recorded reads as enabled, and nothing is written', (t) => {
  const dir = tempDataDir(t);
  const store = createEnablementStore({ filePath: fileIn(dir) });
  assert.equal(store.isEnabled('mcp', 'jira'), true);
  assert.deepEqual(store.all(), {});
  assert.equal(fs.existsSync(fileIn(dir)), false);
});

test('a disable survives the next sync and an enable removes the entry', (t) => {
  const dir = tempDataDir(t);
  createEnablementStore({ filePath: fileIn(dir) }).setEnabled('skills', 'card-analysis', false);

  const reopened = createEnablementStore({ filePath: fileIn(dir) });
  assert.equal(reopened.isEnabled('skills', 'card-analysis'), false);
  const stored = JSON.parse(fs.readFileSync(fileIn(dir), 'utf8'));
  assert.equal(stored.skills['card-analysis'].disabled, true);
  assert.equal(Number.isNaN(Date.parse(stored.skills['card-analysis'].at)), false);

  reopened.setEnabled('skills', 'card-analysis', true);
  assert.equal(reopened.isEnabled('skills', 'card-analysis'), true);
  assert.equal('card-analysis' in JSON.parse(fs.readFileSync(fileIn(dir), 'utf8')).skills, false);
});

test('kinds are kept apart, so a skill and a connector may share a name', (t) => {
  const store = createEnablementStore({ filePath: fileIn(tempDataDir(t)) });
  store.setEnabled('mcp', 'jira', false);
  assert.equal(store.isEnabled('mcp', 'jira'), false);
  assert.equal(store.isEnabled('skills', 'jira'), true);
});

test('a 1.22 enablement file is read as it is', (t) => {
  const dir = tempDataDir(t);
  fs.writeFileSync(fileIn(dir), JSON.stringify({
    mcp: { 'stub-law': { disabled: true, at: '2026-09-01T08:00:00.000Z' } },
    skills: { notes: { disabled: true, at: '2026-09-02T08:00:00.000Z' } },
  }, null, 2));
  const store = createEnablementStore({ filePath: fileIn(dir) });
  assert.equal(store.isEnabled('mcp', 'stub-law'), false);
  assert.equal(store.isEnabled('skills', 'notes'), false);
  assert.equal(store.isEnabled('skills', 'card-analysis'), true);

  store.setEnabled('skills', 'card-analysis', false);
  const stored = JSON.parse(fs.readFileSync(fileIn(dir), 'utf8'));
  assert.deepEqual(Object.keys(stored.mcp), ['stub-law']);
  assert.deepEqual(Object.keys(stored.skills).sort(), ['card-analysis', 'notes']);
  assert.equal(stored.skills.notes.at, '2026-09-02T08:00:00.000Z');
});

test('an unreadable file reads as nothing disabled', (t) => {
  const dir = tempDataDir(t);
  for (const content of ['{ not json', '[1,2]', '"text"', 'null']) {
    fs.writeFileSync(fileIn(dir), content);
    const store = createEnablementStore({ filePath: fileIn(dir) });
    assert.equal(store.isEnabled('mcp', 'jira'), true, content);
    assert.deepEqual(store.all(), {}, content);
  }
});

test('an entry that is not a disable does not disable anything', (t) => {
  const dir = tempDataDir(t);
  fs.writeFileSync(fileIn(dir), JSON.stringify({ mcp: 'x', skills: { a: null, b: { disabled: false }, c: 7 } }));
  const store = createEnablementStore({ filePath: fileIn(dir) });
  for (const name of ['a', 'b', 'c']) assert.equal(store.isEnabled('skills', name), true, name);
  assert.equal(store.isEnabled('mcp', 'x'), true);
});

test('names that are also object keys are ordinary names', (t) => {
  const dir = tempDataDir(t);
  const store = createEnablementStore({ filePath: fileIn(dir) });
  for (const name of ['constructor', 'toString', '__proto__']) {
    assert.equal(store.isEnabled('skills', name), true, name);
    store.setEnabled('skills', name, false);
    assert.equal(store.isEnabled('skills', name), false, name);
  }
  assert.equal(store.isEnabled('skills', 'hasOwnProperty'), true);
  store.setEnabled('skills', '__proto__', true);
  assert.equal(store.isEnabled('skills', '__proto__'), true);
  assert.equal(Object.getPrototypeOf(store.all().skills), Object.prototype);
});

test('the file is private and written whole', (t) => {
  const dir = tempDataDir(t);
  createEnablementStore({ filePath: fileIn(dir) }).setEnabled('mcp', 'jira', false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(fileIn(dir)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['mittr-enablement.json']);
});

test('the directory is created when it is missing', (t) => {
  const dir = tempDataDir(t);
  const filePath = path.join(dir, 'nested', 'mittr-enablement.json');
  createEnablementStore({ filePath }).setEnabled('mcp', 'jira', false);
  assert.equal(createEnablementStore({ filePath }).isEnabled('mcp', 'jira'), false);
});

test('the store switches only mcp and skills, and writes no prototype-like key', (t) => {
  const dir = tempDataDir(t);
  const store = createEnablementStore({ filePath: fileIn(dir) });
  for (const kind of ['models', 'knowledge', '__proto__', 'constructor', 'toString', '', undefined, 7]) {
    assert.throws(() => store.setEnabled(kind, 'x', false), /Only mcp and skills/, String(kind));
    assert.equal(store.isEnabled(kind, 'x'), true, String(kind));
  }
  assert.equal(fs.existsSync(fileIn(dir)), false);

  store.setEnabled('skills', '__proto__', false);
  store.setEnabled('skills', 'constructor', false);
  assert.equal(Object.getPrototypeOf(Object.prototype), null);
  assert.equal({}.disabled, undefined);
  assert.equal({}.at, undefined);
  const stored = JSON.parse(fs.readFileSync(fileIn(dir), 'utf8'));
  assert.deepEqual(Object.keys(stored).sort(), ['skills']);
  assert.deepEqual(Object.keys(stored.skills).sort(), ['__proto__', 'constructor']);
  assert.equal(store.isEnabled('mcp', '__proto__'), true);
  assert.equal(store.isEnabled('skills', '__proto__'), false);
});

test('a file that carries a prototype key for a kind is not trusted for it', (t) => {
  const dir = tempDataDir(t);
  fs.writeFileSync(fileIn(dir), '{"__proto__":{"jira":{"disabled":true}},"mcp":{"law":{"disabled":true}}}');
  const store = createEnablementStore({ filePath: fileIn(dir) });
  assert.equal(store.isEnabled('mcp', 'jira'), true);
  assert.equal(store.isEnabled('mcp', 'law'), false);
  store.setEnabled('mcp', 'other', false);
  assert.equal({}.jira, undefined);
  assert.equal(store.isEnabled('mcp', 'jira'), true);
});
