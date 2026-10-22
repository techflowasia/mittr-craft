import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { repoRoot } from '../../upstream-contract.js';
import { createSpeechState, formatResetTime, nextWeeklyReset } from './speech-state.js';

const at = (iso) => Date.parse(iso);

test('the next weekly reset is the coming Monday 00:00 in Bangkok', () => {
  assert.equal(nextWeeklyReset(at('2026-10-22T05:00:00Z')), '2026-10-25T17:00:00.000Z');
  assert.equal(nextWeeklyReset(at('2026-10-25T16:59:59Z')), '2026-10-25T17:00:00.000Z');
  assert.equal(nextWeeklyReset(at('2026-10-25T17:00:00Z')), '2026-11-01T17:00:00.000Z');
});

test('a block holds until its reset, a null reset holds until Monday, and both clear', () => {
  let now = at('2026-10-22T05:00:00Z');
  const state = createSpeechState({ now: () => now });
  assert.deepEqual(state.view(), { revision: 0, stt: { blockedUntil: null }, tts: { blockedUntil: null } });

  state.block('stt', '2026-10-26T17:00:00Z');
  state.block('tts', null);
  assert.deepEqual(state.view(), { revision: 2, stt: { blockedUntil: '2026-10-26T17:00:00Z' }, tts: { blockedUntil: '2026-10-25T17:00:00.000Z' } });

  state.clear('stt');
  assert.deepEqual(state.view().stt, { blockedUntil: null });
  state.clear('stt');
  assert.equal(state.view().revision, 3);

  now = at('2026-10-25T17:00:01Z');
  assert.deepEqual(state.view().tts, { blockedUntil: null });

  state.block('stt', '2026-11-02T17:00:00Z');
  state.clearAll();
  assert.deepEqual(state.view().stt, { blockedUntil: null });
  state.close();
});

test('the state long-poll answers when a block is added and when it lifts', async () => {
  const state = createSpeechState();
  const since = state.view().revision;
  const added = state.waitForChange(since, 5_000);
  state.block('stt', new Date(Date.now() + 80).toISOString());
  const afterAdd = await added;
  assert.ok(afterAdd.stt.blockedUntil);

  const lifted = await state.waitForChange(afterAdd.revision, 5_000);
  assert.equal(lifted.stt.blockedUntil, null);
  assert.ok(lifted.revision > afterAdd.revision);
  state.close();
});

test('a long-poll behind the revision answers at once, and one with nothing new answers after its wait', async () => {
  const state = createSpeechState();
  state.block('tts', null);
  assert.equal((await state.waitForChange(0, 5_000)).revision, 1);
  const started = Date.now();
  const unchanged = await state.waitForChange(1, 40);
  assert.equal(unchanged.revision, 1);
  assert.ok(Date.now() - started >= 35);
  state.close();
});

test('an aborted long-poll and a closed state stop waiting', async () => {
  const state = createSpeechState();
  const controller = new AbortController();
  const aborted = state.waitForChange(0, 60_000, controller.signal);
  controller.abort();
  assert.equal((await aborted).revision, 0);

  const closed = state.waitForChange(0, 60_000);
  state.close();
  assert.equal((await closed).revision, 0);
  assert.equal((await state.waitForChange(0, 60_000)).revision, 0);
});

const UI_LOADER = `
  import { registerHooks } from 'node:module';
  import fs from 'node:fs';
  import { fileURLToPath } from 'node:url';
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('.') && !/\\.[cm]?[jt]sx?$|\\.json$/.test(specifier)) {
        for (const extension of ['.ts', '.tsx']) {
          const url = new URL(specifier + extension, context.parentURL);
          if (fs.existsSync(fileURLToPath(url))) return nextResolve(url.href, context);
        }
      }
      return nextResolve(specifier, context);
    },
  });
  const ui = await import(process.env.CONTRACT_UI_URL);
  console.log(JSON.stringify(JSON.parse(process.env.CONTRACT_FIXTURES).map((at) => ui.formatResetTime(at, ui.PRODUCT_LOCALE, ui.PRODUCT_TIME_ZONE))));
`;

test('the reset time reads as the UI writes it', () => {
  const fixtures = ['2026-10-26T17:00:00Z', '2026-11-01T17:00:00.000Z', '2026-12-31T23:59:59Z', '2027-02-28T02:05:00Z'];
  assert.equal(formatResetTime('2026-10-26T17:00:00Z'), 'Tue 27 Oct, 00:00');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', UI_LOADER], {
    encoding: 'utf8',
    env: { ...process.env, CONTRACT_UI_URL: pathToFileURL(path.join(repoRoot, 'packages/mittr-ui/src/quota/agentStatus.ts')).href, CONTRACT_FIXTURES: JSON.stringify(fixtures) },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fixtures.map((at) => formatResetTime(at)), JSON.parse(result.stdout.trim().split('\n').at(-1)));
});
