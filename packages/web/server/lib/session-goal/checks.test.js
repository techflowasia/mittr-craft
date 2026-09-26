import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runScriptCheck } from './checks.js';
import { collectGoalEvidence } from './evidence.js';

const tool = (name, input, { status = 'completed', output = '', exit } = {}) => ({
  type: 'tool',
  tool: name,
  state: { status, input, output, metadata: exit === undefined ? {} : { exit } },
});

const turn = (...parts) => [{
  info: { id: 'msg_a', role: 'assistant', time: { created: 10, completed: 20 } },
  parts,
}];

const criterion = (check) => ({ id: 'c1', text: 'criterion', check });

describe('command checks', () => {
  const check = criterion({ type: 'command', command: 'bun test' });

  it('is missing when the command was never run, however confident the report', async () => {
    const evidence = collectGoalEvidence(turn({ type: 'text', text: 'All tests pass.' }));
    expect(await runScriptCheck(check, { directory: '/w', evidence })).toMatchObject({ status: 'missing' });
  });

  it('is missing when the last run failed', async () => {
    const evidence = collectGoalEvidence(turn(tool('bash', { command: 'bun test' }, { exit: 1, output: '1 fail' })));
    const result = await runScriptCheck(check, { directory: '/w', evidence });
    expect(result).toMatchObject({ status: 'missing' });
    expect(result.reason).toContain('exited with 1');
  });

  it('is missing when files changed after the last green run', async () => {
    const evidence = collectGoalEvidence(turn(
      tool('bash', { command: 'bun test' }, { exit: 0 }),
      tool('edit', { filePath: '/w/a.ts' }),
    ));
    expect((await runScriptCheck(check, { directory: '/w', evidence })).reason).toContain('changed after');
  });

  it('is met by a green run after the last edit', async () => {
    const evidence = collectGoalEvidence(turn(
      tool('edit', { filePath: '/w/a.ts' }),
      tool('bash', { command: 'cd /w && bun  test --silent' }, { exit: 0 }),
    ));
    expect(await runScriptCheck(check, { directory: '/w', evidence })).toMatchObject({ status: 'met' });
  });
});

describe('file and source checks', () => {
  let directory;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-checks-'));
    fs.writeFileSync(path.join(directory, 'report.md'), 'Summary\nSee https://example.com/a and https://example.org/b.\n');
    fs.writeFileSync(path.join(directory, 'empty.md'), '');
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const empty = collectGoalEvidence([]);

  it('checks existence and literal content inside the workspace', async () => {
    expect(await runScriptCheck(criterion({ type: 'file', path: 'report.md', contains: 'Summary' }), { directory, evidence: empty }))
      .toMatchObject({ status: 'met' });
    expect(await runScriptCheck(criterion({ type: 'file', path: 'report.md', contains: 'Conclusion' }), { directory, evidence: empty }))
      .toMatchObject({ status: 'missing' });
    expect(await runScriptCheck(criterion({ type: 'file', path: 'empty.md' }), { directory, evidence: empty }))
      .toMatchObject({ status: 'missing' });
    expect(await runScriptCheck(criterion({ type: 'file', path: 'missing.md' }), { directory, evidence: empty }))
      .toMatchObject({ status: 'missing' });
  });

  it('never reads outside the workspace', async () => {
    const result = await runScriptCheck(criterion({ type: 'file', path: '../../etc/hosts' }), { directory, evidence: empty });
    expect(result.status).toBe('missing');
    expect(result.reason).toContain('outside the workspace');
  });

  it('catches a citation that was never opened', async () => {
    const evidence = collectGoalEvidence(turn(tool('webfetch', { url: 'https://example.com/a' }, { output: 'page' })));
    const result = await runScriptCheck(criterion({ type: 'sources', path: 'report.md' }), { directory, evidence });
    expect(result.status).toBe('missing');
    expect(result.reason).toContain('https://example.org/b');
  });

  it('accepts citations that were fetched or returned by a search', async () => {
    const evidence = collectGoalEvidence(turn(
      tool('webfetch', { url: 'https://example.com/a' }, { output: 'page' }),
      tool('websearch', { query: 'b' }, { output: 'Result: https://example.org/b\n' }),
    ));
    expect(await runScriptCheck(criterion({ type: 'sources', path: 'report.md' }), { directory, evidence }))
      .toMatchObject({ status: 'met' });
  });

  it('checks the final report when no file is named', async () => {
    const evidence = collectGoalEvidence(turn({ type: 'text', text: 'Done, no sources.' }));
    expect(await runScriptCheck(criterion({ type: 'sources' }), { directory, evidence }))
      .toMatchObject({ status: 'missing' });
  });
});
