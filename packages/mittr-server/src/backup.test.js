import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

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

  assert.deepEqual(first, { made: true, where: [`${data}.pre-2x-backup`, `${state}.pre-2x-backup`], kept: [] });
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

  assert.deepEqual(second, { made: false, where: [], kept: [] });
  assert.equal(read(path.join(`${data}.pre-2x-backup`, 'opencode', 'opencode.db')), 'sessions');
});

test('backupOnce replaces a partial copy left by an earlier failed attempt', async (t) => {
  const root = tempRoot(t);
  const data = path.join(root, 'data');
  writeFile(path.join(data, 'opencode.db'), 'sessions');
  writeFile(path.join(`${data}.pre-2x-backup.partial`, 'half-copied'), 'partial');

  const result = await backupOnce({ dirs: [data], marker: path.join(root, 'marker') });

  assert.deepEqual(result, { made: true, where: [`${data}.pre-2x-backup`], kept: [] });
  assert.deepEqual(fs.readdirSync(`${data}.pre-2x-backup`), ['opencode.db']);
  assert.equal(fs.existsSync(`${data}.pre-2x-backup.partial`), false);
});

test('existing complete backup without marker is kept untouched', async (t) => {
  const root = tempRoot(t);
  const data = path.join(root, 'data');
  const backupFile = path.join(`${data}.pre-2x-backup`, 'opencode', 'opencode.db');
  writeFile(path.join(data, 'opencode', 'opencode.db'), 'migrated by 2.x');
  writeFile(backupFile, '1.x sessions');
  const before = fs.statSync(backupFile).mtimeMs;
  const marker = path.join(root, 'marker');

  const result = await backupOnce({ dirs: [data], marker });

  assert.deepEqual(result, { made: true, where: [], kept: [`${data}.pre-2x-backup`] });
  assert.equal(read(backupFile), '1.x sessions');
  assert.equal(fs.statSync(backupFile).mtimeMs, before);
  assert.deepEqual(fs.readdirSync(`${data}.pre-2x-backup`), ['opencode']);
  assert.equal(fs.existsSync(marker), true);
});

test('a retry after a failure skips dirs already backed up', async (t) => {
  const root = tempRoot(t);
  const data = path.join(root, 'data');
  const parent = path.join(root, 'share');
  const engine = path.join(parent, 'engine');
  const marker = path.join(root, 'marker');
  writeFile(path.join(data, 'opencode.db'), 'first');
  writeFile(path.join(engine, 'opencode.db'), 'engine');
  fs.chmodSync(parent, 0o555);

  await assert.rejects(backupOnce({ dirs: [data, engine], marker }), /engine\.pre-2x-backup/);
  assert.equal(read(path.join(`${data}.pre-2x-backup`, 'opencode.db')), 'first');
  assert.equal(fs.existsSync(marker), false);

  fs.chmodSync(parent, 0o755);
  writeFile(path.join(data, 'opencode.db'), 'changed since');
  const retry = await backupOnce({ dirs: [data, engine], marker });

  assert.deepEqual(retry, { made: true, where: [`${engine}.pre-2x-backup`], kept: [`${data}.pre-2x-backup`] });
  assert.equal(read(path.join(`${data}.pre-2x-backup`, 'opencode.db')), 'first');
  assert.equal(read(path.join(`${engine}.pre-2x-backup`, 'opencode.db')), 'engine');
  assert.equal(fs.existsSync(marker), true);
});

test('only .partial paths are ever removed', async (t) => {
  const root = tempRoot(t);
  const kept = path.join(root, 'kept');
  const fresh = path.join(root, 'fresh');
  const failing = path.join(root, 'share', 'failing');
  writeFile(path.join(kept, 'a'), 'a');
  writeFile(path.join(`${kept}.pre-2x-backup`, 'a'), 'old a');
  writeFile(path.join(fresh, 'b'), 'b');
  writeFile(path.join(`${fresh}.pre-2x-backup.partial`, 'stale'), 'stale');
  writeFile(path.join(failing, 'c'), 'c');
  fs.chmodSync(path.join(root, 'share'), 0o555);
  const rm = mock.method(fsPromises, 'rm');
  t.after(() => rm.mock.restore());

  await assert.rejects(backupOnce({ dirs: [kept, fresh, failing], marker: path.join(root, 'marker') }));

  const removed = rm.mock.calls.map((call) => call.arguments[0]);
  assert.ok(removed.length > 0);
  for (const target of removed) assert.ok(target.endsWith('.pre-2x-backup.partial'), target);
  assert.equal(read(path.join(`${kept}.pre-2x-backup`, 'a')), 'old a');
  assert.equal(read(path.join(`${fresh}.pre-2x-backup`, 'b')), 'b');
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

// The app or engine may still be running while the backup copies its folder:
// a lock file listed with the folder can be gone by the time it is copied.
test('a file that vanishes during the copy is left out and the rest is backed up', async (t) => {
  const root = tempRoot(t);
  const dataDir = path.join(root, 'app');
  writeFile(path.join(dataDir, 'settings.json'), '{}');
  writeFile(path.join(dataDir, 'source-control-auth.json.lock'), '');
  writeFile(path.join(dataDir, 'sessions', 'one.json'), 'one');
  writeFile(path.join(dataDir, 'sessions', 'two.json.lock'), '');
  const originalCopyFile = fsPromises.copyFile;
  const originalLstat = fsPromises.lstat;
  const copyFile = mock.method(fsPromises, 'copyFile', async (source, target, mode) => {
    if (source.endsWith('source-control-auth.json.lock')) await fsPromises.unlink(source);
    return originalCopyFile(source, target, mode);
  });
  const lstat = mock.method(fsPromises, 'lstat', async (target) => {
    if (target.endsWith('two.json.lock')) await fsPromises.unlink(target);
    return originalLstat(target);
  });
  t.after(() => {
    copyFile.mock.restore();
    lstat.mock.restore();
  });

  const result = await backupOnce({ dirs: [dataDir], marker: path.join(dataDir, 'marker') });

  const backup = `${dataDir}.pre-2x-backup`;
  assert.deepEqual(result.where, [backup]);
  assert.deepEqual(fs.readdirSync(backup).sort(), ['sessions', 'settings.json']);
  assert.deepEqual(fs.readdirSync(path.join(backup, 'sessions')), ['one.json']);
  assert.equal(read(path.join(backup, 'sessions', 'one.json')), 'one');
  assert.equal(fs.statSync(path.join(backup, 'sessions', 'one.json')).mtime.getTime(), OLD_TIME.getTime());
  assert.equal(fs.existsSync(path.join(dataDir, 'marker')), true);
});

test('any other error while copying a file still fails the backup', async (t) => {
  const root = tempRoot(t);
  const dataDir = path.join(root, 'app');
  const marker = path.join(root, 'marker');
  writeFile(path.join(dataDir, 'opencode.db'), 'sessions');
  const copyFile = mock.method(fsPromises, 'copyFile', async () => {
    throw Object.assign(new Error('EIO: i/o error, copyfile'), { code: 'EIO' });
  });
  t.after(() => copyFile.mock.restore());

  await assert.rejects(backupOnce({ dirs: [dataDir], marker }), /EIO/);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(`${dataDir}.pre-2x-backup`), false);
  assert.equal(fs.existsSync(`${dataDir}.pre-2x-backup.partial`), false);
});
