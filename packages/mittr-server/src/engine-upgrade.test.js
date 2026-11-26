import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { BACKUP_DIR, BACKUP_MARKER, ENGINE_DATABASE_BUSY, ENGINE_V1_HISTORY, NEWEST_MIGRATION, createEngineUpgrade } from './engine-upgrade.js';

const tempDataHome = (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-engine-upgrade-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'opencode'));
  return home;
};

const dbFile = (dataHome) => path.join(dataHome, 'opencode', 'opencode.db');
const entries = (dataHome) => fs.readdirSync(path.join(dataHome, 'opencode')).sort();
const backups = (dataHome) => (fs.existsSync(path.join(dataHome, 'opencode')) ? entries(dataHome) : []).filter((name) => name.startsWith(BACKUP_DIR) && !name.includes('.partial'));
const partials = (dataHome) => entries(dataHome).filter((name) => name.includes('.partial'));
const onlyBackup = (dataHome) => {
  const made = backups(dataHome);
  assert.equal(made.length, 1, made.join(', '));
  assert.match(made[0], /^pre-2\.3-backup-\d{8}T\d{6}Z-[0-9a-f]{8}$/);
  return made[0];
};
const backupFile = (dataHome, name = 'opencode.db') => path.join(dataHome, 'opencode', onlyBackup(dataHome), name);
const markerFile = (dataHome) => path.join(dataHome, 'opencode', BACKUP_MARKER);

const change = (dataHome, sql) => {
  const db = new DatabaseSync(dbFile(dataHome));
  db.exec(sql);
  db.close();
};

const migrate = (dataHome) => change(dataHome, `CREATE TABLE IF NOT EXISTS migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL); INSERT INTO migration VALUES ('${NEWEST_MIGRATION}', 1)`);

const database = (dataHome, { v1 = [], v2 = null, state, wal = false } = {}) => {
  const db = new DatabaseSync(dbFile(dataHome));
  if (wal) db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY)');
  for (const id of v1) db.prepare('INSERT INTO session VALUES (?)').run(id);
  if (v2) {
    db.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY)');
    for (const id of v2) db.prepare('INSERT INTO session_v2 VALUES (?)').run(id);
  }
  if (state !== undefined) {
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO kv VALUES (?, ?)').run('migration.v1-v2', state);
  }
  db.close();
};

const logger = () => {
  const lines = [];
  return { lines, log: (...args) => lines.push(args.join(' ')), warn: (...args) => lines.push(args.join(' ')) };
};

const refusesHistory = (promise) => assert.rejects(promise, (error) => {
  assert.equal(error.code, ENGINE_V1_HISTORY);
  assert.match(error.message, /MittrCraft 2\.1\.1/);
  assert.match(error.message, /Nothing was deleted/);
  return true;
});

test('a 1.x database that was never brought over keeps the engine from starting', async (t) => {
  const dataHome = tempDataHome(t);
  database(dataHome, { v1: ['ses_1', 'ses_2'] });
  await refusesHistory(createEngineUpgrade({ logger: logger() }).prepare(dataHome));
});

test('a 1.x database an engine already migrated to an empty new table is still refused', async (t) => {
  const dataHome = tempDataHome(t);
  database(dataHome, { v1: ['ses_1'], v2: [] });
  await refusesHistory(createEngineUpgrade({ logger: logger() }).prepare(dataHome));
});

test('an import that stopped half way is refused while sessions are missing', async (t) => {
  const dataHome = tempDataHome(t);
  database(dataHome, { v1: ['ses_1', 'ses_2'], v2: ['ses_1'], state: JSON.stringify({ phase: 'sessions', cursor: 'ses_1' }) });
  await refusesHistory(createEngineUpgrade({ logger: logger() }).prepare(dataHome));
});

test('a finished import starts, even when a deleted session left its 1.x row behind', async (t) => {
  const dataHome = tempDataHome(t);
  database(dataHome, { v1: ['ses_1', 'ses_2'], v2: ['ses_1'], state: JSON.stringify({ phase: 'completed' }) });
  await createEngineUpgrade({ logger: logger() }).prepare(dataHome);
});

test("a finished import that upstream's top-up reopened starts", async (t) => {
  const dataHome = tempDataHome(t);
  database(dataHome, { v1: ['ses_1', 'ses_2'], v2: ['ses_1'], state: JSON.stringify({ phase: 'sessions', cursor: 'ses_2\uffff' }) });
  await createEngineUpgrade({ logger: logger() }).prepare(dataHome);
});

test('a 1.x database without sessions, a 2.x database and a new install start', async (t) => {
  const empty = tempDataHome(t);
  database(empty);
  const current = tempDataHome(t);
  database(current, { v2: ['ses_1'] });
  const fresh = path.join(tempDataHome(t), 'never-started');
  const upgrade = createEngineUpgrade({ logger: logger() });
  for (const dataHome of [empty, current, fresh]) await upgrade.prepare(dataHome);
  assert.deepEqual(backups(fresh), []);
  assert.equal(fs.existsSync(markerFile(fresh)), true);
});

test('the refusal lifts without a restart once the sessions were brought over', async (t) => {
  const dataHome = tempDataHome(t);
  database(dataHome, { v1: ['ses_1'] });
  const upgrade = createEngineUpgrade({ logger: logger() });
  await refusesHistory(upgrade.prepare(dataHome));
  const db = new DatabaseSync(dbFile(dataHome));
  db.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY); INSERT INTO session_v2 VALUES ('ses_1')");
  db.close();
  await upgrade.prepare(dataHome);
});

test('a refused start changes no chats and makes no backup; reading a write-ahead-log database leaves at most its empty log and index', async (t) => {
  const dataHome = tempDataHome(t);
  database(dataHome, { v1: ['ses_1'], wal: true });
  assert.deepEqual(entries(dataHome), ['opencode.db']);
  const before = fs.readFileSync(dbFile(dataHome));
  await refusesHistory(createEngineUpgrade({ logger: logger() }).prepare(dataHome));
  assert.deepEqual(fs.readFileSync(dbFile(dataHome)), before);
  assert.deepEqual(entries(dataHome).filter((name) => !['opencode.db', 'opencode.db-shm', 'opencode.db-wal'].includes(name)), []);
  if (fs.existsSync(`${dbFile(dataHome)}-wal`)) assert.equal(fs.statSync(`${dbFile(dataHome)}-wal`).size, 0);
});

test('a refused start keeps the pending writes of a write-ahead log that was never folded in', async (t) => {
  const dataHome = tempDataHome(t);
  const db = new DatabaseSync(dbFile(dataHome));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE session (id TEXT PRIMARY KEY); INSERT INTO session VALUES ('ses_1')");
  const copied = tempDataHome(t);
  for (const suffix of ['', '-wal']) fs.copyFileSync(`${dbFile(dataHome)}${suffix}`, `${dbFile(copied)}${suffix}`);
  db.close();
  const before = ['', '-wal'].map((suffix) => fs.readFileSync(`${dbFile(copied)}${suffix}`));
  await refusesHistory(createEngineUpgrade({ logger: logger() }).prepare(copied));
  assert.deepEqual(['', '-wal'].map((suffix) => fs.readFileSync(`${dbFile(copied)}${suffix}`)), before);
});

test('a refused start leaves a rollback-journal database alone in its folder', async (t) => {
  const dataHome = tempDataHome(t);
  database(dataHome, { v1: ['ses_1'] });
  const before = fs.readFileSync(dbFile(dataHome));
  await refusesHistory(createEngineUpgrade({ logger: logger() }).prepare(dataHome));
  assert.deepEqual(fs.readFileSync(dbFile(dataHome)), before);
  assert.deepEqual(entries(dataHome), ['opencode.db']);
});

test('a database that cannot be read is left to the engine, after a backup', async (t) => {
  const dataHome = tempDataHome(t);
  fs.writeFileSync(dbFile(dataHome), 'not a database');
  const log = logger();
  await createEngineUpgrade({ logger: log }).prepare(dataHome);
  assert.equal(fs.readFileSync(backupFile(dataHome), 'utf8'), 'not a database');
  assert.match(log.lines.join('\n'), /could not check/);
});

test('the database and its pending writes are copied aside once, before the engine opens them', async (t) => {
  const dataHome = tempDataHome(t);
  const db = new DatabaseSync(dbFile(dataHome));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE session_v2 (id TEXT PRIMARY KEY); INSERT INTO session_v2 VALUES ('ses_1')");
  const log = logger();
  await createEngineUpgrade({ logger: log }).prepare(dataHome);
  migrate(dataHome);
  db.exec("INSERT INTO session_v2 VALUES ('ses_2')");
  await createEngineUpgrade({ logger: log }).prepare(dataHome);
  db.close();

  const copy = new DatabaseSync(backupFile(dataHome));
  assert.deepEqual(copy.prepare('SELECT id FROM session_v2').all().map((row) => row.id), ['ses_1']);
  copy.close();
  assert.equal(log.lines.filter((line) => line.includes('backed up')).length, 1);
});

test('a database this engine made or already migrated is never backed up', async (t) => {
  const dataHome = tempDataHome(t);
  await createEngineUpgrade({ logger: logger() }).prepare(dataHome);
  database(dataHome, { v2: ['ses_1'] });
  migrate(dataHome);
  await createEngineUpgrade({ logger: logger() }).prepare(dataHome);
  fs.rmSync(markerFile(dataHome));
  await createEngineUpgrade({ logger: logger() }).prepare(dataHome);
  assert.deepEqual(backups(dataHome), []);
});

test('going back to 2.1.1 and upgrading again makes another backup and keeps the first', async (t) => {
  const dataHome = tempDataHome(t);
  database(dataHome, { v2: ['ses_1'] });
  await createEngineUpgrade({ logger: logger() }).prepare(dataHome);
  const first = onlyBackup(dataHome);
  const firstCopy = fs.readFileSync(path.join(dataHome, 'opencode', first, 'opencode.db'));
  migrate(dataHome);
  await createEngineUpgrade({ logger: logger() }).prepare(dataHome);
  assert.deepEqual(backups(dataHome), [first]);

  fs.copyFileSync(path.join(dataHome, 'opencode', first, 'opencode.db'), dbFile(dataHome));
  change(dataHome, "INSERT INTO session_v2 VALUES ('ses_weeks_later')");
  await createEngineUpgrade({ logger: logger() }).prepare(dataHome);

  assert.equal(backups(dataHome).length, 2);
  assert.deepEqual(fs.readFileSync(path.join(dataHome, 'opencode', first, 'opencode.db')), firstCopy);
  const second = new DatabaseSync(path.join(dataHome, 'opencode', backups(dataHome).find((name) => name !== first), 'opencode.db'), { readOnly: true });
  assert.deepEqual(second.prepare('SELECT id FROM session_v2 ORDER BY id').all().map((row) => row.id), ['ses_1', 'ses_weeks_later']);
  second.close();
});

test('an engine that keeps failing before it changes the database does not pile up copies of it', async (t) => {
  const dataHome = tempDataHome(t);
  database(dataHome, { v2: ['ses_1'], wal: true });
  for (let start = 0; start < 3; start += 1) await createEngineUpgrade({ logger: logger() }).prepare(dataHome);
  onlyBackup(dataHome);
});

test('a finished backup whose marker was lost is kept', async (t) => {
  const dataHome = tempDataHome(t);
  database(dataHome, { v2: ['ses_1'] });
  await createEngineUpgrade({ logger: logger() }).prepare(dataHome);
  const name = onlyBackup(dataHome);
  const kept = fs.readFileSync(backupFile(dataHome));
  fs.rmSync(markerFile(dataHome));
  change(dataHome, "INSERT INTO session_v2 VALUES ('ses_2')");
  await createEngineUpgrade({ logger: logger() }).prepare(dataHome);
  assert.ok(backups(dataHome).includes(name));
  assert.deepEqual(fs.readFileSync(path.join(dataHome, 'opencode', name, 'opencode.db')), kept);
});

test('a copy left half made by a process that is gone never counts as a backup, and goes', async (t) => {
  const dataHome = tempDataHome(t);
  database(dataHome, { v2: ['ses_1'] });
  for (const name of [`${BACKUP_DIR}.partial`, `${BACKUP_DIR}.partial-999999999-00c0ffee`]) {
    fs.mkdirSync(path.join(dataHome, 'opencode', name));
    fs.writeFileSync(path.join(dataHome, 'opencode', name, 'opencode.db'), 'half');
  }
  await createEngineUpgrade({ logger: logger() }).prepare(dataHome);
  assert.deepEqual(fs.readFileSync(backupFile(dataHome)), fs.readFileSync(dbFile(dataHome)));
  assert.deepEqual(partials(dataHome), []);
});

test('a copy another running process is making is left to it, and a backup it finished first counts as done', async (t) => {
  const dataHome = tempDataHome(t);
  database(dataHome, { v2: ['ses_1'] });
  const theirs = path.join(dataHome, 'opencode', `${BACKUP_DIR}.partial-${process.ppid}-00c0ffee`);
  fs.mkdirSync(theirs);
  let other = null;
  const copyFile = async (source, target, mode) => {
    other ??= createEngineUpgrade({ logger: logger() }).prepare(dataHome);
    await other;
    await fs.promises.copyFile(source, target, mode);
  };
  const log = logger();
  await createEngineUpgrade({ logger: log, copyFile }).prepare(dataHome);
  assert.deepEqual(fs.readFileSync(backupFile(dataHome)), fs.readFileSync(dbFile(dataHome)));
  assert.deepEqual(partials(dataHome), [path.basename(theirs)]);
  assert.equal(log.lines.some((line) => line.includes('backed up')), false);
});

test('two processes making the first backup at once both start, on one backup', async (t) => {
  const dataHome = tempDataHome(t);
  database(dataHome, { v2: ['ses_1'] });
  const script = `import { createEngineUpgrade } from ${JSON.stringify(new URL('./engine-upgrade.js', import.meta.url).href)};
await createEngineUpgrade({ logger: { log() {}, warn() {} } }).prepare(${JSON.stringify(dataHome)});`;
  const runs = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('exit', (code) => resolve({ code, stderr }));
  })));
  assert.deepEqual(runs.filter(({ code }) => code !== 0), []);
  assert.deepEqual(fs.readFileSync(backupFile(dataHome)), fs.readFileSync(dbFile(dataHome)));
  assert.deepEqual(partials(dataHome), []);
});

test('a database that changes while it is copied is copied again, and never left torn', async (t) => {
  const dataHome = tempDataHome(t);
  database(dataHome, { v2: ['ses_1'] });
  let writes = 0;
  const copyFile = async (source, target, mode) => {
    await fs.promises.copyFile(source, target, mode);
    if (writes++ === 0) {
      const db = new DatabaseSync(dbFile(dataHome));
      db.exec("INSERT INTO session_v2 VALUES ('ses_2')");
      db.close();
    }
  };
  await createEngineUpgrade({ logger: logger(), copyFile }).prepare(dataHome);
  assert.equal(writes, 2);
  assert.deepEqual(fs.readFileSync(backupFile(dataHome)), fs.readFileSync(dbFile(dataHome)));
});

test('a backup that cannot be made keeps the engine from starting and says why', async (t) => {
  const dataHome = tempDataHome(t);
  database(dataHome, { v2: ['ses_1'] });
  const full = async () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); };
  await assert.rejects(createEngineUpgrade({ logger: logger(), copyFile: full }).prepare(dataHome), /backup.*no space left/s);
  assert.equal(fs.existsSync(markerFile(dataHome)), false);
  assert.deepEqual([backups(dataHome), partials(dataHome)], [[], []]);
  await createEngineUpgrade({ logger: logger() }).prepare(dataHome);
});

test('calls at the same time share one backup', async (t) => {
  const dataHome = tempDataHome(t);
  database(dataHome, { v2: ['ses_1'] });
  let copies = 0;
  const copyFile = async (...args) => { copies += 1; await fs.promises.copyFile(...args); };
  const upgrade = createEngineUpgrade({ logger: logger(), copyFile });
  await Promise.all([upgrade.prepare(dataHome), upgrade.prepare(dataHome), upgrade.prepare(dataHome)]);
  assert.equal(copies, 1);
});

const holdLock = (t, dataHome) => {
  const holder = new DatabaseSync(dbFile(dataHome));
  holder.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE');
  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    holder.exec('ROLLBACK');
    holder.close();
  };
  t.after(release);
  return release;
};

test('a database another program keeps locked is not opened, and says another copy is running', async (t) => {
  const dataHome = tempDataHome(t);
  database(dataHome, { v1: ['ses_1'] });
  const release = holdLock(t, dataHome);
  const upgrade = createEngineUpgrade({ logger: logger(), busyDelayMs: 1 });
  const isBusy = (error) => error.code === ENGINE_DATABASE_BUSY && /another copy/.test(error.message);
  await assert.rejects(upgrade.prepare(dataHome), isBusy);
  assert.deepEqual(entries(dataHome), ['opencode.db']);
  assert.equal((await upgrade.check(dataHome)).code, ENGINE_DATABASE_BUSY);

  release();
  await refusesHistory(upgrade.prepare(dataHome));
});

test('a database locked for a moment is read again before giving up', async (t) => {
  const dataHome = tempDataHome(t);
  database(dataHome, { v1: ['ses_1'] });
  const release = holdLock(t, dataHome);
  setTimeout(release, 60);
  await refusesHistory(createEngineUpgrade({ logger: logger(), busyDelayMs: 40 }).prepare(dataHome));
});

test('an engine that imports 1.x chats starts on them, after one backup', async (t) => {
  const dataHome = tempDataHome(t);
  database(dataHome, { v1: ['ses_1'] });
  await createEngineUpgrade({ logger: logger(), importsV1: () => true }).prepare(dataHome);
  onlyBackup(dataHome);
  change(dataHome, "INSERT INTO session VALUES ('ses_2')");
  await createEngineUpgrade({ logger: logger(), importsV1: () => true }).prepare(dataHome);
  onlyBackup(dataHome);
});

test('a home an importing engine was let onto is checked again for the bundled one in the same run', async (t) => {
  const dataHome = tempDataHome(t);
  database(dataHome, { v1: ['ses_1'] });
  let imports = true;
  const upgrade = createEngineUpgrade({ logger: logger(), importsV1: () => imports });
  await upgrade.prepare(dataHome);
  imports = false;
  await refusesHistory(upgrade.prepare(dataHome));
});

test('the check answers what a start would refuse, and makes nothing', async (t) => {
  const refused = tempDataHome(t);
  database(refused, { v1: ['ses_1'] });
  const fine = tempDataHome(t);
  database(fine, { v2: ['ses_1'] });
  const fresh = path.join(tempDataHome(t), 'never-started');
  const upgrade = createEngineUpgrade({ logger: logger() });
  const answer = await upgrade.check(refused);
  assert.equal(answer.code, ENGINE_V1_HISTORY);
  assert.match(answer.message, /MittrCraft 2\.1\.1/);
  assert.equal(await upgrade.check(fine), null);
  assert.equal(await upgrade.check(fresh), null);
  for (const dataHome of [refused, fine]) assert.deepEqual(entries(dataHome), ['opencode.db']);
  assert.equal(fs.existsSync(fresh), false);
});
