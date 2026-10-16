#!/usr/bin/env node
/**
 * Holds a session carry-over proof to its result: `prove-session-carryover.mjs`
 * reports what happened and exits 0 even when the migration timed out or
 * sessions went missing, so the gate reads its JSON with this.
 *
 *   node scripts/mittr/assert-proof.mjs <proof.json> [...]
 *
 * For the database the engine migrated, each file must show: no error; the
 * migration completed and did not time out; no 1.x session missing from
 * `session_v2` (`v1NotInV2 == 0`); `session_v2` and its root sessions not below
 * the 1.x counts from before the run; the API listing, and its distinct ids,
 * not below the 1.x session count; and no message-role difference left
 * unexplained. Exits 1 when any check fails in any file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const atLeast = (value, floor) => Number.isInteger(value) && Number.isInteger(floor) && value >= floor;

/** One `{ name, pass, value }` per check for a parsed proof result. */
export const proofChecks = (result) => {
  const file = result.migration?.file ?? null;
  const before = result.before?.find((entry) => entry.file === file)?.v1 ?? null;
  const after = result.after?.find((entry) => entry.file === file)?.v2 ?? null;
  const sessions = before?.session;
  return [
    { name: 'no error', pass: !result.error, value: result.error ?? null },
    { name: 'the engine migrated a database', pass: file !== null && before !== null && after !== null, value: file },
    {
      name: 'migration completed, no timeout',
      pass: result.migration?.state?.phase === 'completed' && result.migration?.timedOut !== true,
      value: { state: result.migration?.state ?? null, timedOut: result.migration?.timedOut ?? false },
    },
    { name: 'v1NotInV2 == 0', pass: after?.v1NotInV2 === 0, value: after?.v1NotInV2 ?? null },
    { name: 'session_v2 >= 1.x sessions', pass: atLeast(after?.session_v2, sessions), value: `${after?.session_v2} vs ${sessions}` },
    { name: 'root session_v2 >= 1.x root sessions', pass: atLeast(after?.rootSession_v2, before?.rootSession), value: `${after?.rootSession_v2} vs ${before?.rootSession}` },
    {
      name: 'API listed and distinct >= 1.x sessions',
      pass: atLeast(result.api?.listed, sessions) && atLeast(result.api?.distinct, sessions),
      value: `${result.api?.listed}/${result.api?.distinct} vs ${sessions}`,
    },
    { name: 'roles unexplained == 0', pass: result.roles?.unexplained === 0, value: result.roles?.unexplained ?? null },
  ];
};

/** Reads and checks each proof file; returns `{ ok, lines }`. */
export const assertProofFiles = (files) => {
  const lines = [];
  let ok = files.length > 0;
  for (const file of files) {
    lines.push(`${path.basename(file)}:`);
    let checks;
    try {
      checks = proofChecks(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (error) {
      checks = [{ name: 'readable proof JSON', pass: false, value: error.message }];
    }
    for (const { name, pass, value } of checks) {
      lines.push(`  ${pass ? 'PASS' : 'FAIL'}  ${name}  (${JSON.stringify(value)})`);
      ok &&= pass;
    }
  }
  return { ok, lines };
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const files = process.argv.slice(2);
  if (files.length === 0 || files.some((arg) => arg.startsWith('-'))) {
    console.error('Usage: node scripts/mittr/assert-proof.mjs <proof.json> [...]');
    process.exit(1);
  }
  const { ok, lines } = assertProofFiles(files);
  console.log(lines.join('\n'));
  process.exit(ok ? 0 : 1);
}
