import { describe, expect, it, vi } from 'vitest';

import { createChromeApprovals } from './chrome-approvals.js';

const setup = (initial = []) => {
  let settings = { agentChromeApprovedHosts: [...initial] };
  const readSettings = vi.fn(async () => settings);
  const persistSettings = vi.fn(async (changes) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    settings = { ...settings, ...changes };
  });
  const approvals = createChromeApprovals({ readSettings, persistSettings });
  const asked = (id, sessionID, host, permission = 'mittrcraft_chrome') => approvals.handleEvent({ type: 'permission.asked', properties: { id, sessionID, permission, patterns: [host], always: [host], metadata: {} } });
  const replied = (requestID, sessionID, reply) => approvals.handleEvent({ type: 'permission.replied', properties: { requestID, sessionID, reply } });
  return { approvals, asked, replied, stored: () => settings.agentChromeApprovedHosts, persistSettings };
};

describe('createChromeApprovals', () => {
  it('treats persisted hosts as approved for every session', async () => {
    const { approvals } = setup(['plane.techflow.asia']);
    await expect(approvals.isApproved('ses_1', 'plane.techflow.asia')).resolves.toBe(true);
    await expect(approvals.isApproved('ses_1', 'github.com')).resolves.toBe(false);
  });

  it('persists a host only when the user answers always', async () => {
    const { approvals, asked, replied, stored } = setup();
    await asked('per_1', 'ses_1', 'github.com');
    await replied('per_1', 'ses_1', 'always');
    expect(stored()).toEqual(['github.com']);
    await expect(approvals.isApproved('ses_2', 'github.com')).resolves.toBe(true);
  });

  it('grants a host to that session only when the user answers once', async () => {
    const { approvals, asked, replied, stored } = setup();
    await asked('per_1', 'ses_1', 'github.com');
    await replied('per_1', 'ses_1', 'once');
    expect(stored()).toEqual([]);
    await expect(approvals.isApproved('ses_1', 'github.com')).resolves.toBe(true);
    await expect(approvals.isApproved('ses_2', 'github.com')).resolves.toBe(false);
  });

  it('grants nothing on reject, and ignores other permissions and unknown requests', async () => {
    const { approvals, asked, replied, stored } = setup();
    await asked('per_1', 'ses_1', 'github.com');
    await replied('per_1', 'ses_1', 'reject');
    await asked('per_2', 'ses_1', 'evil.example', 'bash');
    await replied('per_2', 'ses_1', 'always');
    await replied('per_unknown', 'ses_1', 'always');
    expect(stored()).toEqual([]);
    await expect(approvals.isApproved('ses_1', 'github.com')).resolves.toBe(false);
    await expect(approvals.isApproved('ses_1', 'evil.example')).resolves.toBe(false);
  });

  it('lets a caller wait for an answer that arrives after it asks', async () => {
    const { approvals, asked, replied } = setup();
    await asked('per_1', 'ses_1', 'github.com');
    const decision = approvals.awaitDecision('ses_1', 'github.com');
    await replied('per_1', 'ses_1', 'once');
    await expect(decision).resolves.toBe('once');
  });

  it('answers at once when the decision already arrived', async () => {
    const { approvals, asked, replied } = setup();
    await asked('per_1', 'ses_1', 'github.com');
    await replied('per_1', 'ses_1', 'reject');
    await expect(approvals.awaitDecision('ses_1', 'github.com')).resolves.toBe('reject');
  });

  it('does not wait for a host nobody was asked about', async () => {
    const { approvals } = setup();
    await expect(approvals.awaitDecision('ses_1', 'github.com')).resolves.toBe(null);
  });

  it('stops waiting when the call is cancelled', async () => {
    const { approvals, asked } = setup();
    await asked('per_1', 'ses_1', 'github.com');
    const controller = new AbortController();
    const decision = approvals.awaitDecision('ses_1', 'github.com', controller.signal);
    controller.abort();
    await expect(decision).rejects.toThrow();
  });

  it('keeps both hosts when two sessions approve at the same time', async () => {
    const { asked, replied, stored } = setup(['plane.techflow.asia']);
    await asked('per_1', 'ses_1', 'github.com');
    await asked('per_2', 'ses_2', 'jira.example');
    await Promise.all([replied('per_1', 'ses_1', 'always'), replied('per_2', 'ses_2', 'always')]);
    expect([...stored()].sort()).toEqual(['github.com', 'jira.example', 'plane.techflow.asia']);
  });

  it('removes a host without dropping one approved meanwhile, and revokes session grants for it', async () => {
    const { approvals, asked, replied, stored } = setup(['plane.techflow.asia', 'github.com']);
    await asked('per_1', 'ses_1', 'jira.example');
    await asked('per_2', 'ses_2', 'github.com');
    await replied('per_2', 'ses_2', 'once');
    await Promise.all([replied('per_1', 'ses_1', 'always'), approvals.removeHost('github.com')]);
    expect([...stored()].sort()).toEqual(['jira.example', 'plane.techflow.asia']);
    await expect(approvals.isApproved('ses_2', 'github.com')).resolves.toBe(false);
  });
});
