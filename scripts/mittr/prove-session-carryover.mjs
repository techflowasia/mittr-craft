#!/usr/bin/env bun
/**
 * Proves what the bundled OpenCode 2.x engine does with a MittrCraft 1.x
 * engine data directory, without changing that directory.
 *
 * What each copy mode does to the source:
 *
 * - default (raw copy): each `opencode*.db` is copied byte for byte together
 *   with its `-wal` and `-shm`, keeping their mtimes. The source files are
 *   only read as plain files; SQLite never opens them, so nothing in the
 *   source dir is written, `-shm` included. Each trio's size and mtime are
 *   read before and after the copy and the copy is retried when a running
 *   MittrCraft wrote in between, so the three files agree with each other.
 * - `--snapshot`: each source db is opened by SQLite read-only and copied with
 *   `VACUUM INTO`, one consistent snapshot even mid-write. A read-only open of
 *   a WAL database still maps the source `-shm` and can update it (and its
 *   mtime); the `.db` and `-wal` are not written.
 *
 * Everything after the copy (counting, the engine run) uses only the copies,
 * under a temporary HOME with every XDG base pointing inside it, on a random
 * port with a random password. The engine is killed afterwards.
 *
 * Usage (bun is required for `bun:sqlite`):
 *
 *   bun scripts/mittr/prove-session-carryover.mjs --source <engine data dir>
 *     [--snapshot]              copy with read-only open + VACUUM INTO (see above)
 *     [--db <name>]             start the engine with OPENCODE_DB=<name>, a plain file name
 *     [--copy-as <from>:<to>]   copy <from> to <to> in the temp copy before the start
 *     [--account-dir <dir>]     an `accounts/<16-hex>` dir; its `opencode` dir is
 *                               copied too and the engine runs with data and
 *                               state under it, as 1.22 does for an account
 *     [--one-root]              all four XDG bases on one root, as Dev's
 *                               MITTRCRAFT_ENGINE_HOME does (default: prod's four bases)
 *     [--engine <binary>]       default: packages/electron/resources/opencode-cli/opencode
 *     [--samples <n>]           sessions to compare message counts for (default 3)
 *     [--json <file>]           also write the full result as JSON
 *     [--keep]                  keep the temp HOME for inspection
 *     [--timeout-ms <ms>]       how long to wait for the migration (default 1800000)
 */

import { Database } from 'bun:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESERVED_PORTS = new Set([57123, 57133]);
const MIGRATION_KEY = 'migration.v1-v2';
const PAGE_LIMIT = 200;

const pageSchema = z.object({
  data: z.array(z.unknown()),
  cursor: z.object({ next: z.string().nullish() }).nullish(),
});
const idSchema = z.object({ id: z.string() });

/** A file name inside the engine data dir: no separators, no `.`/`..`, no `:memory:`. */
const assertPlainFileName = (flag, value) => {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') {
    throw new Error(`${flag} must be a plain file name in the engine data dir, got ${JSON.stringify(value)}`);
  }
};

const parseArgs = (argv) => {
  const args = { samples: 3, keep: false, timeoutMs: 30 * 60 * 1000 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      i += 1;
      return next;
    };
    if (flag === '--source') args.source = value();
    else if (flag === '--db') args.db = value();
    else if (flag === '--copy-as') args.copyAs = value();
    else if (flag === '--account-dir') args.accountDir = value();
    else if (flag === '--engine') args.engine = value();
    else if (flag === '--samples') args.samples = Number(value());
    else if (flag === '--json') args.json = value();
    else if (flag === '--timeout-ms') args.timeoutMs = Number(value());
    else if (flag === '--keep') args.keep = true;
    else if (flag === '--one-root') args.oneRoot = true;
    else if (flag === '--snapshot') args.snapshot = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!args.source) throw new Error('--source <engine data dir> is required');
  if (args.db !== undefined) assertPlainFileName('--db', args.db);
  if (args.copyAs !== undefined) {
    const [from, to, ...rest] = args.copyAs.split(':');
    if (rest.length > 0) throw new Error('--copy-as takes <from>:<to>');
    assertPlainFileName('--copy-as', from ?? '');
    assertPlainFileName('--copy-as', to ?? '');
    args.copyAs = { from, to };
  }
  return args;
};

const isDatabaseFile = (name) => /^opencode.*\.db$/.test(name);

const listDatabases = (dir) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter(isDatabaseFile).sort() : [];

const openReadOnly = (file) => new Database(file, { readonly: true });

const statKey = (file) => {
  try {
    const stat = fs.statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
};

/**
 * Byte copy of a db with its `-wal` and `-shm`, mtimes kept. The source is
 * read as plain files only. When a writer changed any of the three during the
 * copy, the copy is taken again.
 */
const rawCopyDatabase = (source, destination) => {
  const trio = ['', '-wal', '-shm'];
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const before = trio.map((suffix) => statKey(source + suffix));
    for (const suffix of trio) {
      fs.rmSync(destination + suffix, { force: true });
      if (!fs.existsSync(source + suffix)) continue;
      fs.copyFileSync(source + suffix, destination + suffix);
      const { atime, mtime } = fs.statSync(source + suffix);
      fs.utimesSync(destination + suffix, atime, mtime);
    }
    const after = trio.map((suffix) => statKey(source + suffix));
    if (before.join('|') === after.join('|')) return { attempts: attempt };
  }
  throw new Error(`${source} kept changing while it was copied; try again or use --snapshot`);
};

/**
 * `--snapshot`: the source is opened read-only and `VACUUM INTO` writes one
 * consistent snapshot. This can touch the source `-shm` (see the header).
 */
const snapshotDatabase = (source, destination) => {
  const db = openReadOnly(source);
  try {
    db.run(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
  const { atime, mtime } = fs.statSync(source);
  fs.utimesSync(destination, atime, mtime);
  return { attempts: 1 };
};

const copyEngineDir = (sourceDir, targetDir, snapshot) => {
  fs.mkdirSync(targetDir, { recursive: true });
  const copied = [];
  for (const name of listDatabases(sourceDir)) {
    const copy = snapshot ? snapshotDatabase : rawCopyDatabase;
    const { attempts } = copy(path.join(sourceDir, name), path.join(targetDir, name));
    copied.push(attempts > 1 ? `${name} (${attempts} attempts)` : name);
  }
  return copied;
};

const tablesOf = (db) =>
  new Set(db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));

const scalar = (db, sql, ...params) => {
  const row = db.query(sql).get(...params);
  return row ? Object.values(row)[0] : null;
};

const countIfPresent = (db, tables, table, where = '') =>
  tables.has(table) ? scalar(db, `SELECT COUNT(*) FROM ${table} ${where}`) : null;

const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

const inspectDatabase = (file) => {
  const stat = fs.statSync(file);
  const db = openReadOnly(file);
  try {
    const tables = tablesOf(db);
    const migrationRow = tables.has('kv')
      ? db.query('SELECT value, time_updated FROM kv WHERE key = ?').get(MIGRATION_KEY)
      : null;
    const sessionIds = tables.has('session') ? db.query('SELECT id FROM session').all().map((row) => row.id) : [];
    const v2Ids = tables.has('session_v2') ? db.query('SELECT id FROM session_v2').all().map((row) => row.id) : [];
    const v2Set = new Set(v2Ids);
    return {
      file: path.basename(file),
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      v1: {
        session: countIfPresent(db, tables, 'session'),
        rootSession: countIfPresent(db, tables, 'session', 'WHERE parent_id IS NULL'),
        archivedSession: countIfPresent(db, tables, 'session', 'WHERE time_archived IS NOT NULL'),
        message: countIfPresent(db, tables, 'message'),
        part: countIfPresent(db, tables, 'part'),
        project: countIfPresent(db, tables, 'project'),
        newestSessionUpdate: tables.has('session') ? iso(scalar(db, 'SELECT MAX(time_updated) FROM session')) : null,
        oldestSessionCreate: tables.has('session') ? iso(scalar(db, 'SELECT MIN(time_created) FROM session')) : null,
      },
      v2: {
        session_v2: countIfPresent(db, tables, 'session_v2'),
        rootSession_v2: countIfPresent(db, tables, 'session_v2', 'WHERE parent_id IS NULL'),
        session_message: countIfPresent(db, tables, 'session_message'),
        migration: migrationRow ? { value: migrationRow.value, at: iso(migrationRow.time_updated) } : null,
        v1NotInV2: tables.has('session_v2') ? sessionIds.filter((id) => !v2Set.has(id)).length : null,
      },
      sessionIds,
    };
  } finally {
    db.close();
  }
};

const inspectDir = (dir) => listDatabases(dir).map((name) => inspectDatabase(path.join(dir, name)));

/**
 * Sessions that exist only outside the file the engine opens: the ones a
 * carry-over that reads one file would leave behind.
 */
const overlap = (inspections, openedFile) => {
  const target = inspections.find((entry) => entry.file === openedFile);
  const targetIds = new Set(target?.sessionIds ?? []);
  const union = new Set(inspections.flatMap((entry) => entry.sessionIds));
  const outside = {};
  for (const entry of inspections) {
    if (entry.file === openedFile) continue;
    outside[entry.file] = entry.sessionIds.filter((id) => !targetIds.has(id)).length;
  }
  const onlyOutside = [...union].filter((id) => !targetIds.has(id)).length;
  return { distinctSessionsAllFiles: union.size, inOpenedFile: targetIds.size, onlyInOtherFiles: onlyOutside, perOtherFile: outside };
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => (RESERVED_PORTS.has(port) ? freePort().then(resolve, reject) : resolve(port)));
    });
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const openFilesOf = (pid) => {
  const result = spawnSync('lsof', ['-p', String(pid), '-Fn'], { encoding: 'utf8' });
  if (result.status !== 0 && !result.stdout) return [];
  return [...new Set(result.stdout.split('\n').filter((line) => line.startsWith('n') && line.includes('.db')).map((line) => line.slice(1)))];
};

const migrationState = (file) => {
  if (!fs.existsSync(file)) return null;
  let db;
  try {
    db = openReadOnly(file);
    if (!tablesOf(db).has('kv')) return null;
    const row = db.query('SELECT value FROM kv WHERE key = ?').get(MIGRATION_KEY);
    return row ? JSON.parse(row.value) : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
};

const startEngine = async ({ engine, tempHome, bases, extraEnv, logFile }) => {
  const port = await freePort();
  const password = randomBytes(24).toString('hex');
  const workDir = path.join(tempHome, 'work');
  fs.mkdirSync(workDir, { recursive: true });
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: tempHome,
    TMPDIR: path.join(tempHome, 'tmp'),
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    USER: process.env.USER ?? 'user',
    XDG_CONFIG_HOME: bases.config,
    XDG_DATA_HOME: bases.data,
    XDG_STATE_HOME: bases.state,
    XDG_CACHE_HOME: bases.cache,
    OPENCODE_PASSWORD: password,
    OPENCODE_SERVER_PASSWORD: password,
    ...extraEnv,
  };
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  const log = fs.openSync(logFile, 'a');
  const child = spawn(engine, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: workDir,
    env,
    stdio: ['ignore', log, log],
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const headers = {
    Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
    'x-opencode-directory': encodeURIComponent(workDir),
  };
  return { child, exited, port, headers, workDir, base: `http://127.0.0.1:${port}` };
};

const stopEngine = async (engine) => {
  if (!engine || engine.child.exitCode !== null) return;
  engine.child.kill('SIGTERM');
  const result = await Promise.race([engine.exited, sleep(5000).then(() => null)]);
  if (result === null) {
    engine.child.kill('SIGKILL');
    await engine.exited;
  }
};

const getJson = async (engine, pathname, query = {}) => {
  const url = new URL(pathname, engine.base);
  for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: engine.headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${url.pathname}${url.search} -> ${response.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
};

const waitForHealth = async (engine, deadline) => {
  let lastError;
  while (Date.now() < deadline) {
    if (engine.child.exitCode !== null) throw new Error(`engine exited early with code ${engine.child.exitCode}`);
    try {
      return await getJson(engine, '/api/info');
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw new Error(`engine did not become healthy: ${lastError?.message ?? 'timeout'}`);
};

const waitForMigration = async (engine, dbFile, deadline) => {
  const started = Date.now();
  let state = migrationState(dbFile);
  while (Date.now() < deadline) {
    state = migrationState(dbFile);
    if (state?.phase === 'completed') return { state, waitedMs: Date.now() - started };
    if (engine.child.exitCode !== null) throw new Error(`engine exited during migration with code ${engine.child.exitCode}`);
    await sleep(500);
  }
  return { state, waitedMs: Date.now() - started, timedOut: true };
};

/** Every session the API lists for one query, following the cursor to the end. */
const pageSessions = async (engine, query) => {
  const ids = [];
  const seen = new Set();
  let cursor;
  for (let page = 0; page < 10000; page += 1) {
    const body = pageSchema.parse(await getJson(engine, '/api/session', cursor ? { limit: String(PAGE_LIMIT), cursor } : { limit: String(PAGE_LIMIT), ...query }));
    const data = body.data;
    for (const session of data) {
      const parsed = idSchema.safeParse(session);
      if (parsed.success) ids.push(parsed.data.id);
    }
    const next = body.cursor?.next;
    if (!next || data.length === 0 || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }
  return ids;
};

const pageMessages = async (engine, sessionId) => {
  let count = 0;
  const seen = new Set();
  let cursor;
  for (let page = 0; page < 10000; page += 1) {
    const body = pageSchema.parse(await getJson(engine, `/api/session/${encodeURIComponent(sessionId)}/message`, cursor ? { limit: String(PAGE_LIMIT), cursor } : { limit: String(PAGE_LIMIT) }));
    const data = body.data;
    count += data.length;
    const next = body.cursor?.next;
    if (!next || data.length < PAGE_LIMIT || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }
  return count;
};

const pickSamples = (dbFile, wanted) => {
  const db = openReadOnly(dbFile);
  try {
    const tables = tablesOf(db);
    if (!tables.has('session') || !tables.has('message')) return [];
    const picks = [
      ['most messages', 'SELECT s.id AS id FROM session s WHERE s.parent_id IS NULL ORDER BY (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) DESC LIMIT 1'],
      ['newest', 'SELECT id FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 1'],
      ['oldest', 'SELECT id FROM session WHERE parent_id IS NULL ORDER BY time_created ASC LIMIT 1'],
      ['a subagent session', 'SELECT id FROM session WHERE parent_id IS NOT NULL ORDER BY time_updated DESC LIMIT 1'],
    ];
    const chosen = [];
    for (const [why, sql] of picks) {
      if (chosen.length >= wanted) break;
      const id = db.query(sql).get()?.id;
      if (id && !chosen.some((entry) => entry.id === id)) chosen.push({ id, why });
    }
    return chosen.map(({ id, why }) => ({
      id,
      why,
      title: scalar(db, 'SELECT title FROM session WHERE id = ?', id),
      v1Messages: scalar(db, 'SELECT COUNT(*) FROM message WHERE session_id = ?', id),
      v1Parts: tables.has('part') ? scalar(db, 'SELECT COUNT(*) FROM part WHERE session_id = ?', id) : null,
      v2SessionMessages: tables.has('session_message') ? scalar(db, 'SELECT COUNT(*) FROM session_message WHERE session_id = ?', id) : null,
      v2Types: tables.has('session_message')
        ? Object.fromEntries(db.query('SELECT type, COUNT(*) AS n FROM session_message WHERE session_id = ? GROUP BY type').all(id).map((row) => [row.type, row.n]))
        : null,
    }));
  } finally {
    db.close();
  }
};

/**
 * Per session, the 1.x messages by role against the 2.x entries by type.
 * OpenCode's V1 transform turns a compaction pair (a user message carrying a
 * `compaction` part, and the assistant `summary: true` reply to it) into one
 * `compaction` entry, so for a session with k pairs the expected 2.x counts are
 * user - k and assistant - k. `system` and `synthetic` entries are added by
 * 2.x and not compared. Any other difference is reported as unexplained.
 */
const compareRoles = (dbFile) => {
  const db = openReadOnly(dbFile);
  try {
    const tables = tablesOf(db);
    if (!['message', 'part', 'session_message'].every((table) => tables.has(table))) return null;
    const sessions = new Map();
    const entry = (id) => {
      if (!sessions.has(id)) sessions.set(id, { v1: { user: 0, assistant: 0, compactionUser: 0, summaryAssistant: 0 }, v2: {} });
      return sessions.get(id);
    };
    for (const row of db.query("SELECT session_id AS id, json_extract(data, '$.role') AS role, COUNT(*) AS n FROM message GROUP BY 1, 2").all()) {
      entry(row.id).v1[row.role] = (entry(row.id).v1[row.role] ?? 0) + row.n;
    }
    for (const row of db.query("SELECT m.session_id AS id, COUNT(DISTINCT m.id) AS n FROM message m JOIN part p ON p.message_id = m.id WHERE json_extract(m.data, '$.role') = 'user' AND json_extract(p.data, '$.type') = 'compaction' GROUP BY 1").all()) {
      entry(row.id).v1.compactionUser = row.n;
    }
    for (const row of db.query("SELECT session_id AS id, COUNT(*) AS n FROM message WHERE json_extract(data, '$.role') = 'assistant' AND json_extract(data, '$.summary') = 1 GROUP BY 1").all()) {
      entry(row.id).v1.summaryAssistant = row.n;
    }
    for (const row of db.query('SELECT session_id AS id, type, COUNT(*) AS n FROM session_message GROUP BY 1, 2').all()) {
      entry(row.id).v2[row.type] = row.n;
    }
    const totals = { v1User: 0, v1Assistant: 0, v1CompactionPairs: 0, v2User: 0, v2Assistant: 0, v2Compaction: 0, v2System: 0, v2Synthetic: 0 };
    const differing = [];
    for (const [id, { v1, v2 }] of sessions) {
      const pairs = Math.min(v1.compactionUser, v1.summaryAssistant);
      totals.v1User += v1.user;
      totals.v1Assistant += v1.assistant;
      totals.v1CompactionPairs += pairs;
      totals.v2User += v2.user ?? 0;
      totals.v2Assistant += v2.assistant ?? 0;
      totals.v2Compaction += v2.compaction ?? 0;
      totals.v2System += v2.system ?? 0;
      totals.v2Synthetic += v2.synthetic ?? 0;
      if ((v2.user ?? 0) === v1.user && (v2.assistant ?? 0) === v1.assistant) continue;
      const explained =
        pairs > 0 &&
        v1.compactionUser === v1.summaryAssistant &&
        (v2.compaction ?? 0) === pairs &&
        (v2.user ?? 0) === v1.user - pairs &&
        (v2.assistant ?? 0) === v1.assistant - pairs;
      const summaryChars = {
        v1: db.query("SELECT COALESCE(SUM(LENGTH(json_extract(p.data, '$.text'))), 0) AS n FROM part p JOIN message m ON m.id = p.message_id WHERE m.session_id = ? AND json_extract(m.data, '$.summary') = 1 AND json_extract(p.data, '$.type') = 'text'").get(id).n,
        v2: db.query("SELECT COALESCE(SUM(LENGTH(json_extract(data, '$.summary'))), 0) AS n FROM session_message WHERE session_id = ? AND type = 'compaction'").get(id).n,
      };
      differing.push({
        id,
        summaryChars,
        v1: { user: v1.user, assistant: v1.assistant, compactionUser: v1.compactionUser, summaryAssistant: v1.summaryAssistant },
        v2,
        reason: explained && summaryChars.v1 === summaryChars.v2
          ? `compaction pair x${pairs}: 1 user + 1 summary assistant -> 1 compaction entry each, summary text ${summaryChars.v1} -> ${summaryChars.v2} chars`
          : 'UNEXPLAINED',
      });
    }
    return { sessionsCompared: sessions.size, totals, differing, unexplained: differing.filter((item) => item.reason === 'UNEXPLAINED').length };
  } finally {
    db.close();
  }
};

const readLogLines = (dirs, pattern) => {
  const hits = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (!fs.statSync(file).isFile()) continue;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) if (pattern.test(line)) hits.push(`${name}: ${line.slice(0, 400)}`);
    }
  }
  return hits;
};

const withoutIds = (inspections) => inspections.map(({ sessionIds, ...rest }) => rest);

const printTable = (label, inspections) => {
  console.log(`\n${label}`);
  console.log('file'.padEnd(28), 'session'.padStart(8), 'root'.padStart(6), 'message'.padStart(9), 'session_v2'.padStart(11), 'root_v2'.padStart(8), 'v1∉v2'.padStart(6), 'migration', 'mtime');
  for (const entry of inspections) {
    console.log(
      entry.file.padEnd(28),
      String(entry.v1.session ?? '-').padStart(8),
      String(entry.v1.rootSession ?? '-').padStart(6),
      String(entry.v1.message ?? '-').padStart(9),
      String(entry.v2.session_v2 ?? '-').padStart(11),
      String(entry.v2.rootSession_v2 ?? '-').padStart(8),
      String(entry.v2.v1NotInV2 ?? '-').padStart(6),
      entry.v2.migration ? JSON.parse(entry.v2.migration.value).phase : '-',
      entry.mtime,
    );
  }
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const source = path.resolve(args.source);
  const engineBinary = path.resolve(args.engine ?? path.join(repoRoot, 'packages/electron/resources/opencode-cli/opencode'));
  if (!fs.existsSync(engineBinary)) throw new Error(`engine not found: ${engineBinary} (run: bun run --cwd packages/electron prepare:opencode-cli)`);
  const engineVersion = spawnSync(engineBinary, ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.tmpdir() } }).stdout.trim();

  const copyMethod = args.snapshot
    ? 'snapshot: SQLite read-only open + VACUUM INTO (can touch source -shm)'
    : 'raw copy of db + -wal + -shm, mtimes kept; SQLite never opens the source';
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-session-proof-'));
  const devRoot = path.join(tempHome, '.config', 'mittrcraft-dev', 'engine');
  const shared = args.oneRoot ? { config: devRoot, data: devRoot, state: devRoot, cache: devRoot } : {
    config: path.join(tempHome, '.config', 'mittrcraft', 'engine'),
    data: path.join(tempHome, '.local', 'share', 'mittrcraft', 'engine'),
    state: path.join(tempHome, '.local', 'state', 'mittrcraft', 'engine'),
    cache: path.join(tempHome, '.cache', 'mittrcraft', 'engine'),
  };
  let bases = shared;
  const copied = { shared: copyEngineDir(source, path.join(shared.data, 'opencode'), args.snapshot) };
  if (args.accountDir) {
    const accountHome = path.basename(path.resolve(args.accountDir));
    bases = { ...shared, data: path.join(shared.data, 'accounts', accountHome), state: path.join(shared.state, 'accounts', accountHome) };
    copied.account = copyEngineDir(path.join(path.resolve(args.accountDir), 'opencode'), path.join(bases.data, 'opencode'), args.snapshot);
  }
  for (const dir of Object.values(bases)) fs.mkdirSync(dir, { recursive: true });
  const dataDir = path.join(bases.data, 'opencode');

  if (args.copyAs) {
    const { from, to } = args.copyAs;
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(path.join(dataDir, from + suffix))) fs.copyFileSync(path.join(dataDir, from + suffix), path.join(dataDir, to + suffix));
    }
  }

  const before = inspectDir(dataDir);
  const extraEnv = args.db ? { OPENCODE_DB: args.db } : {};
  const expectedFile = args.db ?? 'opencode.db';
  const logFile = path.join(tempHome, 'engine.log');

  console.log(`engine      ${engineVersion} (${engineBinary})`);
  console.log(`source      ${source} (${copyMethod}: ${copied.shared.join(', ') || 'none'})`);
  if (args.accountDir) console.log(`account     ${path.resolve(args.accountDir)} (copied: ${copied.account.join(', ') || 'none'})`);
  console.log(`temp HOME   ${tempHome}`);
  console.log(`engine data ${dataDir} (${args.oneRoot ? 'one root, as Dev' : 'four XDG bases, as prod'})`);
  console.log(`env         ${args.db ? `OPENCODE_DB=${args.db}` : 'OPENCODE_DB unset'}${args.copyAs ? `, pre-start copy ${args.copyAs.from} -> ${args.copyAs.to}` : ''}`);
  printTable('BEFORE (copies, as 1.x left them)', before);

  let engine;
  const result = { engineVersion, source, layout: args.oneRoot ? 'one root (Dev)' : 'four XDG bases (prod)', accountDir: args.accountDir ?? null, opencodeDb: args.db ?? null, copyAs: args.copyAs ?? null, copyMethod, before: withoutIds(before) };
  try {
    const deadline = Date.now() + args.timeoutMs;
    const startedAt = Date.now();
    engine = await startEngine({ engine: engineBinary, tempHome, bases, extraEnv, logFile });
    const info = await waitForHealth(engine, deadline);
    result.healthyAfterMs = Date.now() - startedAt;
    result.info = { version: info?.version ?? info?.data?.version ?? null };
    const openNow = openFilesOf(engine.child.pid);
    const openedDb = openNow.filter((file) => file.endsWith('.db')).map((file) => path.basename(file));
    result.openedByEngine = openedDb;
    const migrationFile = path.join(dataDir, openedDb.find((name) => name !== 'opencode-next.db') ?? expectedFile);
    const migration = await waitForMigration(engine, migrationFile, deadline);
    result.migration = { file: path.basename(migrationFile), ...migration, totalMs: Date.now() - startedAt };

    const apiIds = await pageSessions(engine, {});
    const apiRootIds = await pageSessions(engine, { parentID: 'null' }).catch((error) => ({ error: error.message }));
    result.api = { listed: apiIds.length, distinct: new Set(apiIds).size };
    result.apiRootQuery = Array.isArray(apiRootIds) ? { listed: apiRootIds.length } : apiRootIds;

    const afterMid = inspectDir(dataDir);
    const migrated = afterMid.find((entry) => entry.file === path.basename(migrationFile));
    if (migrated && migrated.v2.session_v2 !== null && result.api.distinct < migrated.v2.session_v2) {
      const db = openReadOnly(path.join(dataDir, migrated.file));
      const projects = db.query('SELECT DISTINCT project_id AS id FROM session_v2').all().map((row) => row.id);
      db.close();
      const union = new Set(apiIds);
      const perProject = {};
      for (const project of projects) {
        const ids = await pageSessions(engine, { project }).catch(() => []);
        perProject[project] = ids.length;
        for (const id of ids) union.add(id);
      }
      result.apiPerProject = { projects: projects.length, perProject, distinctUnion: union.size };
    }

    const samples = pickSamples(migrationFile, args.samples);
    for (const sample of samples) sample.apiMessages = await pageMessages(engine, sample.id).catch((error) => `error: ${error.message}`);
    result.samples = samples;
    result.openAtEnd = openFilesOf(engine.child.pid).map((file) => path.basename(file));
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    await stopEngine(engine);
  }

  const after = inspectDir(dataDir);
  result.after = withoutIds(after);
  result.mtimeChanged = after.filter((entry) => before.find((old) => old.file === entry.file)?.mtime !== entry.mtime).map((entry) => entry.file);
  if (result.migration) result.roles = compareRoles(path.join(dataDir, result.migration.file));
  result.overlap = overlap(before, result.migration?.file ?? expectedFile);
  result.logDbLines = readLogLines([path.join(dataDir, 'log')], /\.db\b|migrat/i).slice(0, 20);
  const engineLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  result.engineStdoutDbLines = engineLog.split('\n').filter((line) => /\.db\b|migrat/i.test(line)).slice(0, 20);

  printTable('AFTER (engine stopped)', after);
  console.log(`\nengine opened      ${(result.openedByEngine ?? []).join(', ') || 'unknown'}`);
  console.log(`mtime changed      ${result.mtimeChanged.join(', ') || 'none'}`);
  if (result.migration) console.log(`migration          ${result.migration.file}: ${JSON.stringify(result.migration.state)} in ${result.migration.waitedMs} ms${result.migration.timedOut ? ' (TIMED OUT)' : ''}`);
  if (result.api) console.log(`API /api/session   ${result.api.listed} listed (${result.api.distinct} distinct); parentID=null: ${JSON.stringify(result.apiRootQuery)}`);
  if (result.apiPerProject) console.log(`API per project    ${result.apiPerProject.distinctUnion} distinct across ${result.apiPerProject.projects} projects`);
  console.log(`only in other files ${result.overlap.onlyInOtherFiles} session(s) of ${result.overlap.distinctSessionsAllFiles} distinct across all files ${JSON.stringify(result.overlap.perOtherFile)}`);
  if (result.roles) {
    const t = result.roles.totals;
    console.log(`roles              ${result.roles.sessionsCompared} sessions; 1.x user ${t.v1User}, assistant ${t.v1Assistant}, compaction pairs ${t.v1CompactionPairs} -> 2.x user ${t.v2User}, assistant ${t.v2Assistant}, compaction ${t.v2Compaction} (+ system ${t.v2System}, synthetic ${t.v2Synthetic})`);
    console.log(`roles differing    ${result.roles.differing.length} session(s), unexplained ${result.roles.unexplained}`);
    for (const item of result.roles.differing) console.log(`  ${item.id}: 1.x ${JSON.stringify(item.v1)} -> 2.x ${JSON.stringify(item.v2)}: ${item.reason}`);
  }
  for (const sample of result.samples ?? []) {
    console.log(`sample ${sample.id} (${sample.why}): v1 message ${sample.v1Messages}, part ${sample.v1Parts} -> session_message ${sample.v2SessionMessages} ${JSON.stringify(sample.v2Types)}, API ${sample.apiMessages}`);
  }
  for (const line of [...result.logDbLines, ...result.engineStdoutDbLines].slice(0, 10)) console.log(`log  ${line}`);
  if (result.error) console.log(`\nERROR ${result.error}\n--- engine log tail ---\n${engineLog.split('\n').slice(-30).join('\n')}`);

  if (args.json) fs.writeFileSync(path.resolve(args.json), `${JSON.stringify(result, null, 2)}\n`);
  if (args.keep) console.log(`\nkept ${tempHome}`);
  else fs.rmSync(tempHome, { recursive: true, force: true });
  if (result.error || result.roles?.unexplained) process.exitCode = 1;
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
