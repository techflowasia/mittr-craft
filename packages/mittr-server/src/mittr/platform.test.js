import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CANNOT_REACH_MITTR, PLATFORM_TIMEOUT_MS, READ_FAILED } from './platform.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceOf = (name) => fs.readFileSync(path.join(here, name), 'utf8');

const PLATFORM_CALLERS = ['auth-routes.js', 'audit-routes.js', 'catalog-routes.js', 'quota-service.js', 'work-routes.js'];

const productionModules = () => fs.readdirSync(here)
  .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js') && name !== 'test-helpers.js');

test('the shared platform values', () => {
  assert.equal(PLATFORM_TIMEOUT_MS, 15_000);
  assert.equal(CANNOT_REACH_MITTR, 'Cannot reach Mittr');
  assert.equal(READ_FAILED, 'Could not read this week’s quota');
});

test('every platform call uses the one timeout', () => {
  for (const name of PLATFORM_CALLERS) {
    const source = sourceOf(name);
    const calls = [...source.matchAll(/AbortSignal\.timeout\(([^)]*)\)/g)].map((match) => match[1].trim());
    assert.ok(calls.length > 0, `${name} makes a platform call with a timeout`);
    for (const argument of calls) {
      if (argument === 'PLATFORM_TIMEOUT_MS') continue;
      assert.equal(argument, 'timeoutMs', `${name} passes ${argument}`);
      assert.match(source, /timeoutMs = PLATFORM_TIMEOUT_MS/, `${name} defaults its timeout option to the shared one`);
    }
    assert.match(source, /import \{[^}]*PLATFORM_TIMEOUT_MS[^}]*\} from '\.\/platform\.js'/, name);
  }
});

test('no module defines its own platform timeout or platform messages', () => {
  for (const name of productionModules().filter((entry) => entry !== 'platform.js')) {
    const source = sourceOf(name);
    assert.doesNotMatch(source, /(?:const|let)\s+PLATFORM_TIMEOUT_MS\b/, `${name} defines the timeout`);
    assert.doesNotMatch(source, /(?:const|let)\s+(?:UNREACHABLE|READ_FAILED)\s*=/, `${name} defines a platform message`);
    assert.equal(source.includes('Cannot reach Mittr'), false, `${name} spells the unreachable message`);
    assert.equal(source.includes('Could not read this week’s quota'), false, `${name} spells the quota read message`);
  }
});
