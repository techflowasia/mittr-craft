import { describe, expect, it, vi } from 'vitest';
import { resolveRepositoryIdentity } from './repository-identity.js';

const withRemote = (url) => ({ getRemoteUrl: vi.fn().mockResolvedValue(url) });

describe('resolveRepositoryIdentity', () => {
  it('reduces an https remote to owner and repository', async () => {
    await expect(resolveRepositoryIdentity('/repo', withRemote('https://github.com/techflowasia/mittr-craft.git')))
      .resolves.toBe('techflowasia/mittr-craft');
  });

  it('reduces an ssh remote the same way', async () => {
    await expect(resolveRepositoryIdentity('/repo', withRemote('git@bitbucket.org:techflowasia/allkons.git')))
      .resolves.toBe('techflowasia/allkons');
  });

  it('returns null when the repository has no remote', async () => {
    await expect(resolveRepositoryIdentity('/repo', withRemote(''))).resolves.toBeNull();
  });

  it('returns null rather than a local path when the lookup throws', async () => {
    const getRemoteUrl = vi.fn().mockRejectedValue(new Error('not a git repository'));
    await expect(resolveRepositoryIdentity('/Users/someone/client-secret', { getRemoteUrl }))
      .resolves.toBeNull();
  });

  it('never returns anything containing the local path', async () => {
    const identity = await resolveRepositoryIdentity(
      '/Users/someone/client-secret',
      withRemote('https://github.com/techflowasia/mittr-craft.git'),
    );
    expect(identity).not.toContain('/Users');
  });
});
