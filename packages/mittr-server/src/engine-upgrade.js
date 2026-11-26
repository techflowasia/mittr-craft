import crypto from 'node:crypto';
import fs, { constants as fsConstants } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export const ENGINE_V1_HISTORY = 'MITTR_ENGINE_V1_HISTORY';
export const ENGINE_DATABASE_BUSY = 'MITTR_ENGINE_DATABASE_BUSY';
export const BACKUP_DIR = 'pre-2.3-backup';
export const BACKUP_MARKER = '.pre-2.3-backup-done';
export const NEWEST_MIGRATION = '20261116213417_automation_active_index';

const DATABASE = 'opencode.db';
const WRITE_AHEAD_LOG = `${DATABASE}-wal`;
const IMPORT_STATE_KEY = 'migration.v1-v2';
const REOPENED_CURSOR_SUFFIX = '\uffff';
const COPY_ATTEMPTS = 3;
const BUSY_ATTEMPTS = 6;
const BUSY_DELAY_MS = 300;
const BUSY_RESULT_CODES = new Set([5, 6]);
const PARTIAL = /^pre-2\.3-backup.*\.partial(?:-(\d+)-[0-9a-f]+)?$/;

const V1_HISTORY_MESSAGE = 'Your chats are still in the MittrCraft 1.x format, which this version cannot read. Nothing was deleted or changed. Quit this app, open MittrCraft 2.1.1 once so it brings them over, then open this version again.';
const DATABASE_BUSY_MESSAGE = 'Your chats are in use by another program, most likely another copy of this app that is still open, so they were not opened. Nothing was changed. Quit the other copy, then try again.';

const refusal = (code, message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code });

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const openReadOnly = (file) => {
  const sqlite = process.getBuiltinModule?.('node:sqlite');
  if (sqlite) {
    const db = new sqlite.DatabaseSync(file, { readOnly: true });
    return { all: (sql, ...params) => db.prepare(sql).all(...params), close: () => db.close() };
  }
  const { Database } = createRequire(import.meta.url)('bun:sqlite');
  const db = new Database(file, { readonly: true });
  return { all: (sql, ...params) => db.query(sql).all(...params), close: () => db.close() };
};

const isBusy = (error) => BUSY_RESULT_CODES.has((error?.errcode ?? error?.errno) & 0xff)
  || /^SQLITE_(BUSY|LOCKED)/.test(String(error?.code ?? ''));

const importFinished = (row) => {
  if (!row) return false;
  try {
    const state = JSON.parse(row.value);
    return state.phase === 'completed' || (typeof state.cursor === 'string' && state.cursor.endsWith(REOPENED_CURSOR_SUFFIX));
  } catch {
    return false;
  }
};

const holdsUnimportedSessions = (db, tables) => {
  if (!tables.has('session')) return false;
  if (tables.has('kv') && importFinished(db.all('SELECT value FROM kv WHERE key = ?', IMPORT_STATE_KEY)[0])) return false;
  const missing = tables.has('session_v2')
    ? 'SELECT 1 FROM session WHERE id NOT IN (SELECT id FROM session_v2) LIMIT 1'
    : 'SELECT 1 FROM session LIMIT 1';
  return db.all(missing).length > 0;
};

const isMigrated = (db, tables) => tables.size === 0
  || (tables.has('migration') && db.all('SELECT 1 FROM migration WHERE id = ?', NEWEST_MIGRATION).length > 0);

const readState = (file) => {
  const db = openReadOnly(file);
  try {
    const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((row) => row.name));
    return { readable: true, unimported: holdsUnimportedSessions(db, tables), migrated: isMigrated(db, tables) };
  } finally {
    db.close();
  }
};

const sizeAndTime = async (file) => {
  try {
    const stat = await fs.promises.stat(file, { bigint: true });
    return { size: stat.size, mtimeNs: stat.mtimeNs };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};

const readSnapshot = async (dir) => {
  const database = await sizeAndTime(path.join(dir, DATABASE));
  if (!database) throw new Error('the database is no longer there');
  const log = await sizeAndTime(path.join(dir, WRITE_AHEAD_LOG));
  const pending = log && log.size > 0n ? log : null;
  const parts = [database, pending].filter(Boolean);
  const id = crypto.createHash('sha256').update(parts.map((part) => `${part.size}:${part.mtimeNs}`).join('|')).digest('hex').slice(0, 8);
  const changed = new Date(Number(parts.reduce((latest, part) => (part.mtimeNs > latest ? part.mtimeNs : latest), 0n) / 1_000_000n));
  const stamp = changed.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
  return { files: pending ? [DATABASE, WRITE_AHEAD_LOG] : [DATABASE], name: `${BACKUP_DIR}-${stamp}-${id}` };
};

const isFinished = (target) => fs.existsSync(path.join(target, DATABASE));

const hasBackup = (dir) => fs.readdirSync(dir).some((name) => name.startsWith(BACKUP_DIR) && !PARTIAL.test(name) && isFinished(path.join(dir, name)));

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

const removeAbandonedPartials = async (dir) => {
  for (const name of await fs.promises.readdir(dir)) {
    const partial = PARTIAL.exec(name);
    if (!partial || (partial[1] && isAlive(Number(partial[1])))) continue;
    await fs.promises.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
  }
};

const copyDatabase = async ({ dir, copyFile }) => {
  const partial = path.join(dir, `${BACKUP_DIR}.partial-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    await removeAbandonedPartials(dir);
    for (let attempt = 1; attempt <= COPY_ATTEMPTS; attempt += 1) {
      const before = await readSnapshot(dir);
      const target = path.join(dir, before.name);
      if (isFinished(target)) return { target, made: false };
      await fs.promises.rm(partial, { recursive: true, force: true });
      await fs.promises.mkdir(partial);
      for (const name of before.files) await copyFile(path.join(dir, name), path.join(partial, name), fsConstants.COPYFILE_FICLONE);
      if (before.name !== (await readSnapshot(dir)).name) continue;
      try {
        await fs.promises.rename(partial, target);
      } catch (error) {
        if (!isFinished(target)) throw error;
        await fs.promises.rm(partial, { recursive: true, force: true });
        return { target, made: false };
      }
      return { target, made: true };
    }
    throw new Error('the database kept changing; another copy of the app may be running');
  } catch (error) {
    await fs.promises.rm(partial, { recursive: true, force: true }).catch(() => {});
    throw new Error(`MittrCraft could not make a backup of your chats before updating them, so it did not open them: ${error?.message ?? error}`, { cause: error });
  }
};

export const createEngineUpgrade = ({ logger, copyFile = fs.promises.copyFile, importsV1 = () => false, busyDelayMs = BUSY_DELAY_MS }) => {
  const prepared = new Set();
  const running = new Map();

  const inspect = async (file) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return readState(file);
      } catch (error) {
        if (!isBusy(error)) {
          logger.warn(`[mittr] could not check ${file} for 1.x chats:`, error?.message ?? error);
          return { readable: false, unimported: false, migrated: false };
        }
        if (attempt >= BUSY_ATTEMPTS) throw refusal(ENGINE_DATABASE_BUSY, DATABASE_BUSY_MESSAGE, error);
      }
      await sleep(busyDelayMs);
    }
  };

  const accept = async (file, canImport) => {
    const state = await inspect(file);
    if (state.unimported && !canImport) throw refusal(ENGINE_V1_HISTORY, V1_HISTORY_MESSAGE);
    return state;
  };

  const run = async (dataHome, canImport) => {
    const dir = path.join(dataHome, 'opencode');
    const file = path.join(dir, DATABASE);
    const marker = path.join(dir, BACKUP_MARKER);

    if (fs.existsSync(file)) {
      const state = await accept(file, canImport);
      const firstTime = !fs.existsSync(marker) && !hasBackup(dir);
      const willMigrate = state.readable && !state.migrated;
      if (firstTime ? !state.migrated : willMigrate && !canImport) {
        const { target, made } = await copyDatabase({ dir, copyFile });
        if (made) logger.log(`[mittr] backed up before an engine update of the chats: ${target}`);
      }
    }
    if (!fs.existsSync(marker)) {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(marker, `${JSON.stringify({ at: new Date().toISOString() })}\n`);
    }
  };

  const keyOf = (dataHome, canImport) => `${canImport ? 'imports' : 'reads'}:${dataHome}`;

  const prepare = (dataHome) => {
    const canImport = importsV1() === true;
    const key = keyOf(dataHome, canImport);
    if (prepared.has(key)) return Promise.resolve();
    const current = running.get(key);
    if (current) return current;
    const next = run(dataHome, canImport).then(() => { prepared.add(key); }).finally(() => running.delete(key));
    running.set(key, next);
    return next;
  };

  const check = async (dataHome) => {
    const canImport = importsV1() === true;
    const file = path.join(dataHome, 'opencode', DATABASE);
    if (prepared.has(keyOf(dataHome, canImport)) || !fs.existsSync(file)) return null;
    try {
      await accept(file, canImport);
      return null;
    } catch (error) {
      return { code: error?.code ?? null, message: String(error?.message ?? error) };
    }
  };

  return { prepare, check };
};
