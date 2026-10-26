#!/usr/bin/env node
/**
 * Records upstream's English text for every key `packages/mittr-ui/src/strings/en.ts`
 * overrides, in `packages/mittr-ui/src/strings/en.upstream-snapshot.json`.
 *
 *   node scripts/mittr/english-snapshot.mjs
 *
 * The upstream contract test compares that snapshot with the current upstream
 * text and names each override whose source text changed or vanished. Run this
 * only after re-reading those overrides against the new upstream text.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  ENGLISH_SNAPSHOT_FILE,
  englishSnapshot,
  readEnglishOverrides,
  repoRoot,
} from '../../packages/mittr-server/src/upstream-contract.js';

const current = readEnglishOverrides();
const missing = Object.keys(current.overrides).filter((key) => !Object.hasOwn(current.upstream, key));
if (missing.length > 0) {
  console.error(`[mittr] these overrides name keys upstream no longer has; remove or rename them first:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
const snapshot = englishSnapshot(current);
fs.writeFileSync(path.join(repoRoot, ENGLISH_SNAPSHOT_FILE), `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`[mittr] recorded upstream English for ${Object.keys(snapshot).length} overrides in ${ENGLISH_SNAPSHOT_FILE}`);
