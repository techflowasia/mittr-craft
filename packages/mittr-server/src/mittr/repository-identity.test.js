import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRepositoryIdentity } from './repository-identity.js';

const withRemote = (url) => ({ remoteUrl: async () => url });
const identityOf = (url) => resolveRepositoryIdentity('/repo', withRemote(url));

test('an https remote is reduced to owner and repository', async () => {
  assert.equal(await identityOf('https://github.com/techflowasia/mittr-craft.git'), 'techflowasia/mittr-craft');
});

test('an ssh remote is reduced the same way', async () => {
  assert.equal(await identityOf('git@bitbucket.org:techflowasia/allkons.git'), 'techflowasia/allkons');
  assert.equal(await identityOf('ssh://git@host.example:2222/techflowasia/allkons.git'), 'techflowasia/allkons');
  assert.equal(await identityOf('host.example:techflowasia/allkons'), 'techflowasia/allkons');
});

test('a remote without the .git suffix or with a trailing slash is reduced too', async () => {
  assert.equal(await identityOf('https://github.com/techflowasia/mittr-craft'), 'techflowasia/mittr-craft');
  assert.equal(await identityOf('https://github.com/techflowasia/mittr-craft/'), 'techflowasia/mittr-craft');
});

test('credentials in the remote never reach the identity', async () => {
  for (const url of [
    'https://person:s3cret-token@github.com/techflowasia/mittr-craft.git',
    'https://s3cret-token@github.com/techflowasia/mittr-craft.git',
    'https://person:s3cret-token@bitbucket.org:443/techflowasia/mittr-craft.git',
  ]) {
    const identity = await identityOf(url);
    assert.equal(identity, 'techflowasia/mittr-craft');
    assert.equal(identity.includes('s3cret'), false);
  }
});

test('a remote with no owner level and credentials is no identity at all', async () => {
  assert.equal(await identityOf('https://person:s3cret-token@host.example/repo.git'), null);
  assert.equal(await identityOf('https://s3cret-token@host.example/repo'), null);
});

test('a repository without a remote has no identity', async () => {
  assert.equal(await identityOf(''), null);
  assert.equal(await identityOf(null), null);
  assert.equal(await identityOf(undefined), null);
});

test('a lookup that throws, or a git service that is missing, has no identity', async () => {
  const failing = { remoteUrl: async () => { throw new Error('not a git repository'); } };
  assert.equal(await resolveRepositoryIdentity('/Users/someone/client-secret', failing), null);
  assert.equal(await resolveRepositoryIdentity('/Users/someone/client-secret', {}), null);
});

test('a remote that is a local path is no identity, so a folder name never leaves the machine', async () => {
  for (const url of ['/Users/someone/client-secret.git', '../client-secret', 'C:\\work\\client-secret', 'C:/work/client-secret', 'file:///Users/someone/client-secret.git']) {
    assert.equal(await identityOf(url), null, url);
  }
});

test('the identity never contains the local directory it was asked about', async () => {
  const identity = await resolveRepositoryIdentity('/Users/someone/client-secret', withRemote('https://github.com/techflowasia/mittr-craft.git'));
  assert.equal(identity.includes('/Users'), false);
  assert.equal(identity.includes('client-secret'), false);
});

test('the lookup is asked about the directory it was given', async () => {
  const asked = [];
  await resolveRepositoryIdentity('/repo/sub', { remoteUrl: async (directory) => { asked.push(directory); return null; } });
  assert.deepEqual(asked, ['/repo/sub']);
});
