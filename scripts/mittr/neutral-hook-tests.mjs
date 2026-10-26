#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { TEST_FILE, isOwned } from './check-upstream-touch.mjs';

export const DEFAULT_BASE = 'e302062e3';
export const PRODUCT_WORDS = /mittr|mittrcraft|api-dev\.mittr|api\.mittr/i;

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
  cwd,
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
});

const nulFields = (output) => output.split('\0').filter((field) => field !== '');

export const findProductWordsInHookTests = ({ cwd = process.cwd(), base = DEFAULT_BASE } = {}) => {
  const inBase = new Set(nulFields(git(cwd, 'ls-tree', '-r', '-z', '--name-only', base)));
  const changed = nulFields(git(cwd, 'diff', '--name-only', '-z', '--no-renames', '--diff-filter=d', base, 'HEAD'));
  const findings = [];
  for (const file of changed.sort()) {
    if (!TEST_FILE.test(file) || (isOwned(file) && !inBase.has(file))) continue;
    const absolute = path.join(cwd, file);
    if (!fs.existsSync(absolute)) continue;
    fs.readFileSync(absolute, 'utf8').split('\n').forEach((text, index) => {
      if (PRODUCT_WORDS.test(text)) findings.push({ file, line: index + 1, text: text.trim() });
    });
  }
  return findings;
};

export const formatFindings = (findings) => [
  ...findings.map(({ file, line, text }) => `${file}:${line}: ${text}`),
  `${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}`,
].join('\n');

const USAGE = `Usage: node scripts/mittr/neutral-hook-tests.mjs [--help]

Lists every line that names the product in a test file outside our own folders
that differs from ${DEFAULT_BASE}. Exits 1 when there is any.`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 0 && !(args.length === 1 && (args[0] === '--help' || args[0] === '-h'))) throw new Error(`unknown argument ${args[0]}`);
    if (args.length === 1) {
      console.log(USAGE);
      process.exit(0);
    }
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const findings = findProductWordsInHookTests({ cwd: repoRoot });
    console.log(formatFindings(findings));
    process.exitCode = findings.length === 0 ? 0 : 1;
  } catch (error) {
    console.error(`[mittr] ${error.message}`);
    process.exitCode = 1;
  }
}
