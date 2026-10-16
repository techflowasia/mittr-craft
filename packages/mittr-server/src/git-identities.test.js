import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { ensureGitIdentityStore, legacyGitIdentitiesFile } from './git-identities.js';
import { setupMittrServer } from './plugin.js';
import { repoRoot } from './upstream-contract.js';

const PROFILE = { id: 'work', name: 'Work', userName: 'Ada', userEmail: 'ada@example.test', color: 'keyword', icon: 'branch' };

const tempHome = (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-identities-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
};

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const recordingLogger = () => {
  const lines = [];
  return { lines, log: (...args) => lines.push(args.join(' ')), warn: (...args) => lines.push(args.join(' ')) };
};

test('ensureGitIdentityStore seeds a Dev data dir from the store 1.22 kept in the prod folder', async (t) => {
  const home = tempHome(t);
  writeJson(legacyGitIdentitiesFile(home), { profiles: [PROFILE] });
  const dataDir = path.join(home, '.config', 'mittrcraft-dev');

  const result = await ensureGitIdentityStore({ dataDir, homeDir: home, logger: recordingLogger() });

  assert.deepEqual(result, { created: true, seededFrom: legacyGitIdentitiesFile(home) });
  const target = path.join(dataDir, 'git-identities.json');
  assert.deepEqual(readJson(target), { profiles: [PROFILE] });
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dataDir), ['git-identities.json']);
});

test('ensureGitIdentityStore leaves an existing store alone', async (t) => {
  const home = tempHome(t);
  const dataDir = path.join(home, '.config', 'mittrcraft');
  writeJson(path.join(dataDir, 'git-identities.json'), { profiles: [PROFILE], extra: 1 });
  const before = fs.readFileSync(path.join(dataDir, 'git-identities.json'), 'utf8');

  assert.deepEqual(await ensureGitIdentityStore({ dataDir, homeDir: home }), { created: false, seededFrom: null });
  assert.equal(fs.readFileSync(path.join(dataDir, 'git-identities.json'), 'utf8'), before);
});

test('ensureGitIdentityStore writes an empty store when there is nothing to copy', async (t) => {
  const home = tempHome(t);
  for (const dataDir of [path.join(home, '.config', 'mittrcraft'), path.join(home, '.config', 'mittrcraft-dev')]) {
    const result = await ensureGitIdentityStore({ dataDir, homeDir: home });
    assert.equal(result.created, true);
    assert.deepEqual(readJson(path.join(dataDir, 'git-identities.json')), { profiles: [] });
  }
});

test('ensureGitIdentityStore starts empty and says why when the 1.22 store is unusable', async (t) => {
  for (const content of ['{"profiles": [', JSON.stringify({ profiles: [{ id: 'x' }] }), JSON.stringify([PROFILE])]) {
    const home = tempHome(t);
    fs.mkdirSync(path.dirname(legacyGitIdentitiesFile(home)), { recursive: true });
    fs.writeFileSync(legacyGitIdentitiesFile(home), content);
    const dataDir = path.join(home, '.config', 'mittrcraft-dev');
    const logger = recordingLogger();

    assert.deepEqual(await ensureGitIdentityStore({ dataDir, homeDir: home, logger }), { created: true, seededFrom: null });
    assert.deepEqual(readJson(path.join(dataDir, 'git-identities.json')), { profiles: [] });
    assert.equal(logger.lines.length, 1);
    assert.match(logger.lines[0], /did not copy git identities/);
  }
});

// Reads the identities through upstream's own store in a child process whose
// HOME is the temp home, as the packaged server would.
const readThroughUpstream = (home, dataDir) => {
  const script = `
    const { getProfiles } = await import(process.env.IDENTITY_STORAGE_URL);
    console.log(JSON.stringify(getProfiles()));
  `;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: {
      ...env,
      HOME: home,
      OPENCHAMBER_DATA_DIR: dataDir,
      IDENTITY_STORAGE_URL: pathToFileURL(path.join(repoRoot, 'packages/web/server/lib/git/identity-storage.js')).href,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

test('after setup, reading git identities never creates ~/.config/openchamber', async (t) => {
  const home = tempHome(t);
  writeJson(legacyGitIdentitiesFile(home), { profiles: [PROFILE] });
  const dataDir = path.join(home, '.config', 'mittrcraft-dev');
  const env = { MITTRCRAFT_ENGINE_HOME: path.join(dataDir, 'engine') };

  await setupMittrServer({ dataDir, logger: recordingLogger(), env, homeDir: home });

  assert.deepEqual(readThroughUpstream(home, dataDir), [PROFILE]);
  assert.equal(fs.existsSync(path.join(home, '.config', 'openchamber')), false);
});
