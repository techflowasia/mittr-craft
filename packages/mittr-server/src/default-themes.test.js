import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createThemeRuntime } from '../../web/server/lib/opencode/theme-runtime.js';
import { DEFAULT_THEME_MARK, DEFAULT_THEMES, installDefaultThemes } from './default-themes.js';
import { tempDataDir } from './mittr/test-helpers.js';

const themesOf = (dataDir) => path.join(dataDir, 'themes');
const fileOf = (dataDir, id) => path.join(themesOf(dataDir), `${id}.json`);
const readTheme = (dataDir, id) => JSON.parse(fs.readFileSync(fileOf(dataDir, id), 'utf8'));
const quiet = { log: () => {}, warn: () => {} };

test('the defaults carry the ids the built-ins and the glass key on, and our mark', () => {
  assert.deepEqual(DEFAULT_THEMES.map((theme) => [theme.metadata.id, theme.metadata.variant, theme.metadata.source]), [
    ['openchamber-light', 'light', DEFAULT_THEME_MARK],
    ['openchamber-dark', 'dark', DEFAULT_THEME_MARK],
  ]);
});

test('missing themes are written into <dataDir>/themes, and upstream reads them back as custom themes with the same ids', async (t) => {
  const dataDir = tempDataDir(t);
  assert.deepEqual(installDefaultThemes({ dataDir, logger: quiet }), { 'openchamber-light': 'written', 'openchamber-dark': 'written' });
  for (const theme of DEFAULT_THEMES) assert.deepEqual(readTheme(dataDir, theme.metadata.id), theme);
  const runtime = createThemeRuntime({ fsPromises: fs.promises, path, themesDir: themesOf(dataDir), maxThemeJsonBytes: 512 * 1024, logger: quiet });
  const loaded = await runtime.readCustomThemesFromDisk();
  assert.deepEqual(loaded.map((theme) => theme.metadata.id).sort(), ['openchamber-dark', 'openchamber-light']);
});

test('our own files are left alone when current and brought up to date when not', (t) => {
  const dataDir = tempDataDir(t);
  installDefaultThemes({ dataDir, logger: quiet });
  const before = fs.statSync(fileOf(dataDir, 'openchamber-light')).mtimeMs;
  const stale = { ...DEFAULT_THEMES[1], metadata: { ...DEFAULT_THEMES[1].metadata, version: '1.0.0' } };
  fs.writeFileSync(fileOf(dataDir, 'openchamber-dark'), JSON.stringify(stale));
  assert.deepEqual(installDefaultThemes({ dataDir, logger: quiet }), { 'openchamber-light': 'current', 'openchamber-dark': 'updated' });
  assert.equal(fs.statSync(fileOf(dataDir, 'openchamber-light')).mtimeMs, before);
  assert.deepEqual(readTheme(dataDir, 'openchamber-dark'), DEFAULT_THEMES[1]);
});

test('a person\'s own theme with one of those ids is never overwritten, whatever it holds', (t) => {
  const dataDir = tempDataDir(t);
  fs.mkdirSync(themesOf(dataDir), { recursive: true });
  const mine = { metadata: { id: 'openchamber-light', name: 'Mine', variant: 'light' }, colors: {} };
  fs.writeFileSync(fileOf(dataDir, 'openchamber-light'), JSON.stringify(mine));
  fs.writeFileSync(fileOf(dataDir, 'openchamber-dark'), '{ not json');
  assert.deepEqual(installDefaultThemes({ dataDir, logger: quiet }), { 'openchamber-light': 'theirs', 'openchamber-dark': 'theirs' });
  assert.deepEqual(readTheme(dataDir, 'openchamber-light'), mine);
  assert.equal(fs.readFileSync(fileOf(dataDir, 'openchamber-dark'), 'utf8'), '{ not json');
});

test('a person\'s theme under another file name that claims the id wins, and ours steps aside', (t) => {
  const dataDir = tempDataDir(t);
  installDefaultThemes({ dataDir, logger: quiet });
  const mine = { metadata: { id: 'openchamber-dark', name: 'Night', variant: 'dark' }, colors: {} };
  fs.writeFileSync(path.join(themesOf(dataDir), 'night.json'), JSON.stringify(mine));
  assert.deepEqual(installDefaultThemes({ dataDir, logger: quiet }), { 'openchamber-light': 'current', 'openchamber-dark': 'theirs' });
  assert.equal(fs.existsSync(fileOf(dataDir, 'openchamber-dark')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(themesOf(dataDir), 'night.json'), 'utf8')), mine);
});

test('a link in the themes folder is never written through', (t) => {
  const dataDir = tempDataDir(t);
  const elsewhere = tempDataDir(t);
  fs.mkdirSync(themesOf(dataDir), { recursive: true });
  fs.symlinkSync(path.join(elsewhere, 'target.json'), fileOf(dataDir, 'openchamber-light'));
  assert.equal(installDefaultThemes({ dataDir, logger: quiet })['openchamber-light'], 'theirs');
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('the splash colours, taken from each theme\'s background, are opaque', () => {
  for (const theme of DEFAULT_THEMES) {
    assert.match(theme.colors.surface.background, /^#[0-9a-f]{6}$/i, theme.metadata.id);
    assert.match(theme.colors.surface.foreground, /^#[0-9a-f]{6}$/i, theme.metadata.id);
  }
});
