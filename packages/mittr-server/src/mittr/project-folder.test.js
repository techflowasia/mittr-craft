import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { serve, tempDataDir } from './test-helpers.js';
import { copyMittrFolder, createProjectFolderNotices, registerProjectFolderRoutes, scanMittrFolder } from './project-folder.js';

const write = (root, rel, text) => {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');

const project = (t) => {
  const root = fs.realpathSync(tempDataDir(t));
  write(root, '.mittr/agents/review.md', 'review agent');
  write(root, '.mittr/command/ship.md', 'ship command');
  write(root, '.mittr/skills/deploy/SKILL.md', 'deploy skill');
  write(root, '.mittr/skills/deploy/notes/steps.txt', 'steps');
  write(root, '.mittr/plans/old.md', 'a plan');
  write(root, '.mittr/mittr.json', '{}');
  write(root, '.opencode/agents/review.md', 'my own review agent');
  return root;
};

test('scan lists the agents, commands and skills in .mittr and which of them .opencode lacks', (t) => {
  const root = project(t);
  assert.deepEqual(scanMittrFolder(root), {
    files: ['agents/review.md', 'command/ship.md', 'skills/deploy/SKILL.md', 'skills/deploy/notes/steps.txt'],
    missing: ['command/ship.md', 'skills/deploy/SKILL.md', 'skills/deploy/notes/steps.txt'],
  });
});

test('scan finds nothing in a project without .mittr, or whose .mittr holds no agents, commands or skills', (t) => {
  const bare = fs.realpathSync(tempDataDir(t));
  assert.deepEqual(scanMittrFolder(bare), { files: [], missing: [] });
  write(bare, '.mittr/plans/old.md', 'a plan');
  assert.deepEqual(scanMittrFolder(bare), { files: [], missing: [] });
});

test('copy puts each missing file in .opencode, never overwrites one there, names what it skipped and leaves .mittr as it was', (t) => {
  const root = project(t);
  const before = scanMittrFolder(root).files.map((rel) => [rel, read(root, `.mittr/${rel}`)]);
  assert.deepEqual(copyMittrFolder(root), {
    copied: ['command/ship.md', 'skills/deploy/SKILL.md', 'skills/deploy/notes/steps.txt'],
    skipped: ['agents/review.md'],
  });
  assert.equal(read(root, '.opencode/agents/review.md'), 'my own review agent');
  assert.equal(read(root, '.opencode/command/ship.md'), 'ship command');
  assert.equal(read(root, '.opencode/skills/deploy/notes/steps.txt'), 'steps');
  assert.equal(fs.existsSync(path.join(root, '.opencode', 'plans')), false);
  assert.equal(fs.existsSync(path.join(root, '.opencode', 'mittr.json')), false);
  for (const [rel, text] of before) assert.equal(read(root, `.mittr/${rel}`), text);
  assert.deepEqual(scanMittrFolder(root).missing, []);
});

test('a file that appears in .opencode between the scan and the copy is skipped, not overwritten', (t) => {
  const root = project(t);
  const realCopy = fs.copyFileSync;
  t.mock.method(fs, 'copyFileSync', (from, to, mode) => {
    if (to.endsWith(path.join('command', 'ship.md'))) fs.writeFileSync(to, 'written meanwhile');
    return realCopy(from, to, mode);
  });
  const result = copyMittrFolder(root);
  assert.ok(result.skipped.includes('command/ship.md'));
  assert.equal(read(root, '.opencode/command/ship.md'), 'written meanwhile');
});

test('links inside .mittr are never followed, so nothing outside the project is read or copied', (t) => {
  const root = fs.realpathSync(tempDataDir(t));
  const outside = fs.realpathSync(tempDataDir(t));
  write(outside, 'secret.md', 'outside');
  write(outside, 'skill/SKILL.md', 'outside skill');
  write(root, '.mittr/agents/real.md', 'real');
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, '.mittr', 'agents', 'linked.md'));
  fs.symlinkSync(path.join(outside, 'skill'), path.join(root, '.mittr', 'agents', 'linked-dir'));
  fs.symlinkSync(outside, path.join(root, '.mittr', 'skills'));
  assert.deepEqual(scanMittrFolder(root).files, ['agents/real.md']);
  assert.deepEqual(copyMittrFolder(root), { copied: ['agents/real.md'], skipped: [] });
  assert.deepEqual(fs.readdirSync(path.join(root, '.opencode', 'agents')), ['real.md']);
});

test('a .mittr that is itself a link is not read', (t) => {
  const root = fs.realpathSync(tempDataDir(t));
  const outside = fs.realpathSync(tempDataDir(t));
  write(outside, 'agents/a.md', 'outside');
  fs.symlinkSync(outside, path.join(root, '.mittr'));
  assert.deepEqual(scanMittrFolder(root), { files: [], missing: [] });
});

test('a .opencode, or a folder in it, that links out of the project is never written through', (t) => {
  const root = project(t);
  const outside = fs.realpathSync(tempDataDir(t));
  fs.rmSync(path.join(root, '.opencode'), { recursive: true });
  fs.symlinkSync(outside, path.join(root, '.opencode'));
  assert.throws(() => copyMittrFolder(root), { statusCode: 409 });
  assert.deepEqual(fs.readdirSync(outside), []);

  const other = project(t);
  fs.symlinkSync(outside, path.join(other, '.opencode', 'skills'));
  const result = copyMittrFolder(other);
  assert.deepEqual(result.skipped, ['agents/review.md', 'skills/deploy/SKILL.md', 'skills/deploy/notes/steps.txt']);
  assert.deepEqual(result.copied, ['command/ship.md']);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('the notices remember each project they were answered for', (t) => {
  const dataDir = tempDataDir(t);
  const notices = createProjectFolderNotices({ dataDir });
  assert.equal(notices.answered('/a'), false);
  notices.answer('/a');
  assert.equal(createProjectFolderNotices({ dataDir }).answered('/a'), true);
  assert.equal(createProjectFolderNotices({ dataDir }).answered('/b'), false);
  assert.equal((fs.statSync(path.join(dataDir, 'mittr-project-folders.json')).mode & 0o777), 0o600);
});

const setUp = async (t, { scope = 'local', projects = null } = {}) => {
  const dataDir = tempDataDir(t);
  const root = project(t);
  const app = express();
  registerProjectFolderRoutes(app, {
    express,
    host: {},
    requestScope: () => scope,
    projects: async () => projects ?? [{ id: 'p', path: root }],
    notices: createProjectFolderNotices({ dataDir }),
  });
  return { call: await serve(t, app), root, dataDir };
};

test('status offers the copy once for a known project with something missing, and dismissing it ends the offer', async (t) => {
  const { call, root } = await setUp(t);
  assert.deepEqual(await call('POST', '/api/mittr/project-folder/status', { directory: root }), {
    status: 200,
    body: { offer: true, files: ['command/ship.md', 'skills/deploy/SKILL.md', 'skills/deploy/notes/steps.txt'] },
  });
  assert.deepEqual(await call('POST', '/api/mittr/project-folder/dismiss', { directory: root }), { status: 200, body: { answered: true } });
  assert.deepEqual((await call('POST', '/api/mittr/project-folder/status', { directory: root })).body, { offer: false, files: [] });
  assert.equal(fs.existsSync(path.join(root, '.opencode', 'command')), false);
});

test('copying through the route answers the notice and reports what was copied and skipped', async (t) => {
  const { call, root } = await setUp(t);
  assert.deepEqual(await call('POST', '/api/mittr/project-folder/copy', { directory: `${root}${path.sep}` }), {
    status: 200,
    body: { copied: ['command/ship.md', 'skills/deploy/SKILL.md', 'skills/deploy/notes/steps.txt'], skipped: ['agents/review.md'] },
  });
  assert.deepEqual((await call('POST', '/api/mittr/project-folder/status', { directory: root })).body, { offer: false, files: [] });
});

test('nothing is offered or copied for a folder that is not one of the person\'s projects', async (t) => {
  const elsewhere = project(t);
  const { call } = await setUp(t);
  assert.deepEqual((await call('POST', '/api/mittr/project-folder/status', { directory: elsewhere })).body, { offer: false, files: [] });
  assert.equal((await call('POST', '/api/mittr/project-folder/copy', { directory: elsewhere })).status, 404);
  assert.equal((await call('POST', '/api/mittr/project-folder/copy', { directory: 'relative/path' })).status, 400);
  assert.equal((await call('POST', '/api/mittr/project-folder/copy', {})).status, 400);
  assert.equal(fs.existsSync(path.join(elsewhere, '.opencode', 'command')), false);
});

test('the routes answer only this Mac', async (t) => {
  const { call, root } = await setUp(t, { scope: 'remote' });
  for (const verb of ['status', 'copy', 'dismiss']) {
    assert.equal((await call('POST', `/api/mittr/project-folder/${verb}`, { directory: root })).status, 403);
  }
  assert.equal(fs.existsSync(path.join(root, '.opencode', 'command')), false);
});

test('a project path that no longer exists is not offered', async (t) => {
  const gone = path.join(os.tmpdir(), `mittr-gone-${process.pid}-${Date.now()}`);
  const { call } = await setUp(t, { projects: [{ id: 'g', path: gone }] });
  assert.deepEqual((await call('POST', '/api/mittr/project-folder/status', { directory: gone })).body, { offer: false, files: [] });
});
