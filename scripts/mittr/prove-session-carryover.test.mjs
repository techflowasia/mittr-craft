import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { compareRoles, compareV2, inspectDatabase, overlap, parseArgs, pickSamples, readV2, sourceVersionOf } from './prove-session-carryover.mjs';

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const V1_TABLES = [
  'CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)',
  'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)',
  'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT)',
  'CREATE TABLE project (id TEXT PRIMARY KEY)',
];
const V2_TABLES = [
  'CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT, time_updated INTEGER)',
  'CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)',
  'CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT)',
  'CREATE TABLE session_part (message_id TEXT, session_id TEXT, ordinal INTEGER, type TEXT, data TEXT, PRIMARY KEY (message_id, ordinal))',
];

const database = (statements) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-carryover-'));
  dirs.push(dir);
  const file = path.join(dir, 'opencode.db');
  const db = new Database(file, { create: true });
  for (const sql of statements) db.run(sql);
  db.close();
  return file;
};

const COMPLETED = `INSERT INTO kv VALUES ('migration.v1-v2', '{"phase":"completed"}', 1)`;
const BORN_IN_V2 = [
  "INSERT INTO session_v2 VALUES ('ses_a', NULL, 'A', 1, 5), ('ses_b', 'ses_a', 'B', 2, 3)",
  `INSERT INTO session_message VALUES ('m1', 'ses_a', 'user', 1, '{"text":"hello"}'), ('m2', 'ses_a', 'assistant', 2, '{"text":"hi"}'), ('m3', 'ses_b', 'user', 1, '{}')`,
  `INSERT INTO session_part VALUES ('m2', 'ses_a', 0, 'text', '{"text":"hi"}')`,
];
const v2Database = (...more) => database([...V2_TABLES, COMPLETED, ...BORN_IN_V2, ...more]);

test('a database the engine already migrated, or made, is a 2.x source and the rest are 1.x', () => {
  const versionOf = (statements) => sourceVersionOf(inspectDatabase(database(statements)));
  const oldSession = "INSERT INTO session VALUES ('ses_old', NULL, 'Old', 1, 1, NULL)";
  expect(versionOf([...V1_TABLES])).toBe('1.x');
  expect(versionOf([...V1_TABLES, oldSession, ...V2_TABLES])).toBe('1.x');
  expect(versionOf([...V1_TABLES, oldSession, ...V2_TABLES, COMPLETED])).toBe('1.x');
  expect(versionOf([...V1_TABLES, oldSession, ...V2_TABLES, COMPLETED, ...BORN_IN_V2])).toBe('2.x');
  expect(versionOf([...V1_TABLES, ...V2_TABLES, ...BORN_IN_V2])).toBe('2.x');
  expect(versionOf([...V2_TABLES])).toBe('2.x');
  expect(sourceVersionOf(undefined)).toBe('1.x');
});

test('sessions born in 2.x, which the 1.x comparison cannot explain, carry over unchanged in the 2.x one', () => {
  const before = v2Database();
  const mixed = database([...V1_TABLES, ...V2_TABLES, COMPLETED, ...BORN_IN_V2]);
  expect(compareRoles(mixed).unexplained).toBe(2);
  expect(compareV2(readV2(mixed), readV2(mixed))).toMatchObject({ sessionsCompared: 2, unexplained: 0, differing: [] });
  expect(compareV2(readV2(before), readV2(v2Database()))).toEqual({
    sessionsCompared: 2,
    totals: { sessionsBefore: 2, sessionsAfter: 2, messagesBefore: 3, messagesAfter: 3, partsBefore: 1, partsAfter: 1 },
    differing: [],
    unexplained: 0,
  });
});

test('a session, message or part that is gone or changed is unexplained', () => {
  const before = readV2(v2Database());
  const differ = (...statements) => compareV2(before, readV2(v2Database(...statements)));
  expect(differ("DELETE FROM session_v2 WHERE id = 'ses_b'", "DELETE FROM session_message WHERE session_id = 'ses_b'")).toMatchObject({
    unexplained: 1, differing: [{ id: 'ses_b', reason: 'UNEXPLAINED', missingSession: true }],
  });
  expect(differ("DELETE FROM session_message WHERE id = 'm1'")).toMatchObject({
    unexplained: 1, differing: [{ id: 'ses_a', reason: 'UNEXPLAINED', messages: { missing: 1, changed: 0, added: 0 } }],
  });
  expect(differ(`UPDATE session_message SET data = '{}' WHERE id = 'm2'`)).toMatchObject({
    unexplained: 1, differing: [{ id: 'ses_a', messages: { missing: 0, changed: 1, added: 0 } }],
  });
  expect(differ("UPDATE session_message SET type = 'system' WHERE id = 'm3'").unexplained).toBe(1);
  expect(differ("UPDATE session_message SET session_id = 'ses_b', seq = 9 WHERE id = 'm1'").unexplained).toBe(1);
  expect(differ("DELETE FROM session_part WHERE message_id = 'm2'")).toMatchObject({
    unexplained: 1, differing: [{ id: 'ses_a', parts: { missing: 1, changed: 0, added: 0 } }],
  });
});

test('entries a start adds are listed, and are not a loss', () => {
  const after = readV2(v2Database(
    `INSERT INTO session_message VALUES ('m4', 'ses_b', 'system', 2, '{}')`,
    "INSERT INTO session_v2 VALUES ('ses_c', NULL, 'C', 9, 9)",
  ));
  expect(compareV2(readV2(v2Database()), after)).toMatchObject({
    sessionsCompared: 2,
    unexplained: 0,
    totals: { sessionsAfter: 3, messagesAfter: 4 },
    differing: [{ id: 'ses_b', reason: 'entries added only', messages: { missing: 0, changed: 0, added: 1 } }],
  });
});

test('a database without the 2.x tables has nothing to compare, and losing them is a loss', () => {
  expect(readV2(database([...V1_TABLES]))).toBe(null);
  expect(readV2('/nonexistent/opencode.db')).toBe(null);
  expect(compareV2(null, readV2(v2Database()))).toBe(null);
  expect(compareV2(readV2(v2Database()), null)).toMatchObject({ unexplained: 2 });
});

test('sessions only another file holds are counted by the tables of the source version', () => {
  const inspections = [{ ...inspectDatabase(v2Database()), file: 'opencode.db' }, { ...inspectDatabase(v2Database("INSERT INTO session_v2 VALUES ('ses_c', NULL, 'C', 9, 9)")), file: 'opencode-next.db' }];
  expect(overlap(inspections, 'opencode.db', '2.x')).toEqual({ distinctSessionsAllFiles: 3, inOpenedFile: 2, onlyInOtherFiles: 1, perOtherFile: { 'opencode-next.db': 1 } });
  expect(overlap(inspections, 'opencode.db').distinctSessionsAllFiles).toBe(0);
});

test('samples of a 2.x source come from its own tables', () => {
  const samples = pickSamples(v2Database(), 3, '2.x');
  expect(samples.map(({ id, why }) => [id, why])).toEqual([['ses_a', 'most messages'], ['ses_b', 'a subagent session']]);
  expect(samples[0]).toMatchObject({ title: 'A', v1Messages: null, v2SessionMessages: 2, v2Types: { user: 1, assistant: 1 } });
});

test('--from names the source version, and anything else is refused', () => {
  expect(parseArgs(['--source', 'x']).from).toBe(undefined);
  expect(parseArgs(['--source', 'x', '--from', '2.x']).from).toBe('2.x');
  expect(() => parseArgs(['--source', 'x', '--from', '3.x'])).toThrow('--from');
});
