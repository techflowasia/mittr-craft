import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MITTR_PROVIDER_ID } from './mittrProvider';

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));

const sourceFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return sourceFiles(full);
  return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
});

describe('the Mittr provider id', () => {
  test('is the engine provider id', () => {
    expect(MITTR_PROVIDER_ID).toBe('mittr');
  });

  test('is defined in one file', () => {
    const definitions = sourceFiles(SOURCE_DIR).filter((file) => /^\s*(?:export\s+)?const\s+MITTR_PROVIDER_ID\b/m.test(readFileSync(file, 'utf8')));
    expect(definitions.map((file) => path.basename(file))).toEqual(['mittrProvider.ts']);
  });
});
