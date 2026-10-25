import { describe, expect, test } from 'bun:test';

import { openChildSession, type OpenChildDeps } from './openChild';

const deps = (over: Partial<OpenChildDeps> = {}) => {
  const calls: unknown[][] = [];
  const value: OpenChildDeps = {
    directory: '/p',
    isMobile: false,
    isVSCode: false,
    setCurrentSession: (...args) => { calls.push(['navigate', ...args]); },
    openContextPanelTab: (...args) => { calls.push(['panel', ...args]); },
    ...over,
  };
  return { value, calls };
};

describe('openChildSession', () => {
  test('the desktop and web window open the subagent read-only in the side panel', () => {
    const { value, calls } = deps();
    openChildSession(value, 'ses_child', 'Look up the docs');
    expect(calls).toEqual([['panel', '/p', { mode: 'chat', dedupeKey: 'session:ses_child', label: 'Look up the docs', readOnly: true }]]);
  });

  test('mobile and VS Code go to the subagent instead', () => {
    for (const over of [{ isMobile: true }, { isVSCode: true }]) {
      const { value, calls } = deps(over);
      openChildSession(value, 'ses_child', 'x');
      expect(calls).toEqual([['navigate', 'ses_child', '/p']]);
    }
  });

  test('nothing opens without a project directory', () => {
    const { value, calls } = deps({ directory: null });
    openChildSession(value, 'ses_child', 'x');
    expect(calls).toEqual([]);
  });
});
