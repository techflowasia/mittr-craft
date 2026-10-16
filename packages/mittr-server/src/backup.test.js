import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { backupOnce } from './backup.js';

const OLD_TIME = new Date('2026-01-02T03:04:05Z');

const tempRoot = (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-backup-')));
  t.after(() => {
    fs.chmodSync(root, 0o755);
    for (const entry of fs.readdirSync(root)) fs.chmodSync(path.join(root, entry), 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
};

const writeFile = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.utimesSync(file, OLD_TIME, OLD_TIME);
};

const read = (file) => fs.readFileSync(file, 'utf8');

test('backupOnce copies once then skips', async (t) => {
  const root = tempRoot(t);
  const data = path.join(root, 'data');
  const state = path.join(root, 'state');
  const marker = path.join(root, 'app', '.pre-2x-backup-done');
  writeFile(path.join(data, 'opencode', 'opencode.db'), 'sessions');
  writeFile(path.join(state, 'accounts', '0123456789abcdef', 'opencode', 'kv.json'), 'account state');

  const first = await backupOnce({ dirs: [data, state, path.join(root, 'missing')], marker });

  assert.deepEqual(first, { made: true, where: [`${data}.pre-2x-backup`, `${state}.pre-2x-backup`] });
  assert.equal(read(path.join(`${data}.pre-2x-backup`, 'opencode', 'opencode.db')), 'sessions');
  assert.equal(
    read(path.join(`${state}.pre-2x-backup`, 'accounts', '0123456789abcdef', 'opencode', 'kv.json')),
    'account state',
  );
  assert.equal(
    fs.statSync(path.join(`${data}.pre-2x-backup`, 'opencode', 'opencode.db')).mtimeMs,
    OLD_TIME.getTime(),
  );
  assert.equal(fs.existsSync(marker), true);
  assert.equal(fs.existsSync(path.join(root, 'missing.pre-2x-backup')), false);

  writeFile(path.join(data, 'opencode', 'opencode.db'), 'migrated by 2.x');
  const second = await backupOnce({ dirs: [data, state], marker });

  assert.deepEqual(second, { made: false, where: [] });
  assert.equal(read(path.join(`${data}.pre-2x-backup`, 'opencode', 'opencode.db')), 'sessions');
});

test('backupOnce replaces a partial backup left by an earlier failed attempt', async (t) => {
  const root = tempRoot(t);
  const data = path.join(root, 'data');
  writeFile(path.join(data, 'opencode.db'), 'sessions');
  writeFile(path.join(`${data}.pre-2x-backup`, 'half-copied'), 'partial');

  await backupOnce({ dirs: [data], marker: path.join(root, 'marker') });

  assert.deepEqual(fs.readdirSync(`${data}.pre-2x-backup`), ['opencode.db']);
});

test('backupOnce copies a folder nested in another listed folder only once', async (t) => {
  const root = tempRoot(t);
  const dataDir = path.join(root, 'mittrcraft-dev');
  const engine = path.join(dataDir, 'engine');
  writeFile(path.join(engine, 'opencode', 'opencode.db'), 'sessions');
  writeFile(path.join(dataDir, 'settings.json'), '{}');

  const result = await backupOnce({ dirs: [engine, engine, dataDir], marker: path.join(dataDir, 'marker') });

  assert.deepEqual(result.where, [`${dataDir}.pre-2x-backup`]);
  assert.equal(read(path.join(`${dataDir}.pre-2x-backup`, 'engine', 'opencode', 'opencode.db')), 'sessions');
  assert.equal(fs.existsSync(`${engine}.pre-2x-backup`), false);
});

test('backupOnce leaves out excluded paths, backup folders and sockets', async (t) => {
  const root = tempRoot(t);
  const dataDir = path.join(root, 'app');
  writeFile(path.join(dataDir, 'settings.json'), '{}');
  writeFile(path.join(dataDir, 'speech-models', 'model.bin'), 'weights');
  writeFile(path.join(dataDir, 'engine.pre-2x-backup', 'stale'), 'stale');
  const socketPath = path.join(dataDir, 's.sock');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => server.close());

  await backupOnce({
    dirs: [dataDir],
    marker: path.join(dataDir, 'marker'),
    exclude: [path.join(dataDir, 'speech-models')],
  });

  assert.deepEqual(fs.readdirSync(`${dataDir}.pre-2x-backup`), ['settings.json']);
});

test('backupOnce rejects and writes no marker when a copy fails', async (t) => {
  const root = tempRoot(t);
  const parent = path.join(root, 'share');
  const data = path.join(parent, 'engine');
  const marker = path.join(root, 'marker');
  writeFile(path.join(data, 'opencode.db'), 'sessions');
  fs.chmodSync(parent, 0o555);

  await assert.rejects(backupOnce({ dirs: [data], marker }), /engine\.pre-2x-backup/);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(read(path.join(data, 'opencode.db')), 'sessions');
});
