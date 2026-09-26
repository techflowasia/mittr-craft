import { describe, expect, test } from 'bun:test';
import { resolveProjectForSessionDirectory } from './projectResolution';

const projects = [
  { id: 'mittrcraft', path: '/workspace/mittrcraft', label: 'MittrCraft' },
];

describe('resolveProjectForSessionDirectory', () => {
  test('resolves a sibling worktree to its registered project', () => {
    const worktrees = new Map([
      ['/workspace/mittrcraft', [{
        path: '/workspace/mittrcraft-feature',
        projectDirectory: '/workspace/mittrcraft',
        branch: 'feature',
        label: 'feature',
      }]],
    ]);

    expect(resolveProjectForSessionDirectory(projects, worktrees, '/workspace/mittrcraft-feature')).toEqual(projects[0]);
  });
});
