import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEnablementStore } from './local-enablement.js';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-enable-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const store = () => createEnablementStore({ filePath: path.join(dir, 'enablement.json') });

describe('local enablement', () => {
  it('treats anything never touched as enabled', () => {
    expect(store().isEnabled('mcp', 'jira')).toBe(true);
  });

  it('remembers a disable across restarts', () => {
    store().setEnabled('mcp', 'jira', false);
    expect(store().isEnabled('mcp', 'jira')).toBe(false);
  });

  it('keeps kinds apart so a skill and a connector may share a name', () => {
    const s = store();
    s.setEnabled('mcp', 'jira', false);
    expect(s.isEnabled('skills', 'jira')).toBe(true);
  });

  it('re-enables when asked', () => {
    const s = store();
    s.setEnabled('mcp', 'jira', false);
    s.setEnabled('mcp', 'jira', true);
    expect(s.isEnabled('mcp', 'jira')).toBe(true);
  });
});
