import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { parseCatalogSkill, reconcileSkills } from './skill-reconciler.js';
import { tempDataDir } from './test-helpers.js';

const KEY_A = '0123456789abcdef';
const KEY_B = 'fedcba9876543210';

const skillText = (name, body = 'Body') => `---\nname: ${name}\ndescription: Reads cards\n---\n${body}\n`;
const skill = (name, version = '1.0.0', files = [{ path: 'SKILL.md', content: skillText(name, `Body ${version}`) }]) => ({ name, version, files });
const catalogOf = (items, { configured = true } = {}) => ({
  bundleVersion: 1,
  models: { configured: false, items: [] },
  mcp: { configured: false, items: [] },
  skills: { configured, items },
  knowledge: { configured: false, items: [] },
});
const enablementOf = (disabled = []) => ({ isEnabled: (kind, name) => !(kind === 'skills' && disabled.includes(name)) });
const allEnabled = enablementOf();

const MINE = skillText('mine', 'My own skill');
const MITTR_MINE = skillText('mittr-mine', 'Also my own');

const skillsHome = (t) => {
  const root = path.join(tempDataDir(t), 'opencode', 'skills');
  nodeFs.mkdirSync(path.join(root, 'mine'), { recursive: true });
  nodeFs.writeFileSync(path.join(root, 'mine', 'SKILL.md'), MINE);
  nodeFs.mkdirSync(path.join(root, 'mittr-mine'), { recursive: true });
  nodeFs.writeFileSync(path.join(root, 'mittr-mine', 'SKILL.md'), MITTR_MINE);
  const untouched = () => {
    assert.equal(nodeFs.readFileSync(path.join(root, 'mine', 'SKILL.md'), 'utf8'), MINE);
    assert.deepEqual(nodeFs.readdirSync(path.join(root, 'mine')), ['SKILL.md']);
    assert.equal(nodeFs.readFileSync(path.join(root, 'mittr-mine', 'SKILL.md'), 'utf8'), MITTR_MINE);
    assert.deepEqual(nodeFs.readdirSync(path.join(root, 'mittr-mine')), ['SKILL.md']);
  };
  return { root, untouched };
};

const read = (root, ...parts) => nodeFs.readFileSync(path.join(root, ...parts), 'utf8');
const exists = (root, ...parts) => nodeFs.existsSync(path.join(root, ...parts));
const entries = (root) => nodeFs.readdirSync(root).sort();
const workOf = (root) => path.join(path.dirname(root), '.mittr-skills-work');
const run = (root, catalog, { accountKey = KEY_A, enablement = allEnabled, fs } = {}) => reconcileSkills({ catalog, enablement, skillsRoot: root, accountKey, ...(fs ? { fs } : {}) });
const NOTHING = { installed: [], updated: [], removed: [], failed: [] };

test('installs a catalog skill with its version marker', (t) => {
  const { root, untouched } = skillsHome(t);
  const result = run(root, catalogOf([skill('card-analysis', '1.0.0', [
    { path: 'SKILL.md', content: skillText('card-analysis') },
    { path: 'references/fields.md', content: 'Fields' },
  ])]));

  assert.deepEqual(result, { ...NOTHING, installed: ['mittr-card-analysis'] });
  assert.equal(read(root, 'mittr-card-analysis', 'SKILL.md'), skillText('mittr-card-analysis'));
  assert.equal(read(root, 'mittr-card-analysis', 'references', 'fields.md'), 'Fields');
  assert.equal(read(root, 'mittr-card-analysis', '.mittr-version').trim(), '1.0.0');
  assert.equal(read(root, '.mittr-account').trim(), KEY_A);
  assert.deepEqual(entries(root), ['.mittr-account', 'mine', 'mittr-card-analysis', 'mittr-mine']);
  untouched();
});

test('only the frontmatter name line is rewritten to the folder name', (t) => {
  const { root, untouched } = skillsHome(t);
  const renamed = '---\r\ndescription: Reads cards\r\nname: "card-analysis"\r\nmetadata:\r\n  name: inner\r\n---\r\nname: in the body\r\n';
  const already = '---\nname: mittr-notes\ndescription: Notes\n---\nBody\n';
  const bare = '# No frontmatter\nname: card\n';
  run(root, catalogOf([
    skill('card-analysis', '1', [{ path: 'SKILL.md', content: renamed }]),
    skill('notes', '1', [{ path: 'SKILL.md', content: already }]),
    skill('bare', '1', [{ path: 'SKILL.md', content: bare }, { path: 'extra.md', content: '---\nname: other\n---\n' }]),
  ]));

  assert.equal(read(root, 'mittr-card-analysis', 'SKILL.md'), '---\r\ndescription: Reads cards\r\nname: mittr-card-analysis\r\nmetadata:\r\n  name: inner\r\n---\r\nname: in the body\r\n');
  assert.equal(read(root, 'mittr-notes', 'SKILL.md'), already);
  assert.equal(read(root, 'mittr-bare', 'SKILL.md'), bare);
  assert.equal(read(root, 'mittr-bare', 'extra.md'), '---\nname: other\n---\n');
  untouched();
});

test('the same version is not rewritten', async (t) => {
  const { root, untouched } = skillsHome(t);
  const catalog = catalogOf([skill('card-analysis', '1.0.0')]);
  run(root, catalog);
  const before = nodeFs.statSync(path.join(root, 'mittr-card-analysis', 'SKILL.md')).mtimeMs;
  const markerBefore = nodeFs.statSync(path.join(root, '.mittr-account')).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(run(root, catalog), NOTHING);
  assert.equal(nodeFs.statSync(path.join(root, 'mittr-card-analysis', 'SKILL.md')).mtimeMs, before);
  assert.equal(nodeFs.statSync(path.join(root, '.mittr-account')).mtimeMs, markerBefore);
  untouched();
});

test('a new version replaces the installed one', (t) => {
  const { root, untouched } = skillsHome(t);
  run(root, catalogOf([skill('card-analysis', '1.0.0', [{ path: 'SKILL.md', content: skillText('card-analysis') }, { path: 'old.md', content: 'old' }])]));

  const result = run(root, catalogOf([skill('card-analysis', '2.0.0')]));

  assert.deepEqual(result, { ...NOTHING, updated: ['mittr-card-analysis'] });
  assert.equal(read(root, 'mittr-card-analysis', '.mittr-version').trim(), '2.0.0');
  assert.equal(read(root, 'mittr-card-analysis', 'SKILL.md'), skillText('mittr-card-analysis', 'Body 2.0.0'));
  assert.equal(exists(root, 'mittr-card-analysis', 'old.md'), false);
  assert.deepEqual(entries(root), ['.mittr-account', 'mine', 'mittr-card-analysis', 'mittr-mine']);
  untouched();
});

test('a withdrawn skill is removed', (t) => {
  const { root, untouched } = skillsHome(t);
  run(root, catalogOf([skill('card-analysis'), skill('notes')]));

  const result = run(root, catalogOf([skill('notes')]));

  assert.deepEqual(result, { ...NOTHING, removed: ['mittr-card-analysis'] });
  assert.equal(exists(root, 'mittr-card-analysis'), false);
  assert.equal(exists(root, 'mittr-notes', 'SKILL.md'), true);
  untouched();
});

test('the last withdrawn skill takes the account marker with it', (t) => {
  const { root, untouched } = skillsHome(t);
  run(root, catalogOf([skill('card-analysis')]));

  assert.deepEqual(run(root, catalogOf([])), { ...NOTHING, removed: ['mittr-card-analysis'] });
  assert.deepEqual(entries(root), ['mine', 'mittr-mine']);
  untouched();
});

test('a disabled skill is removed and stays removed across syncs', (t) => {
  const { root, untouched } = skillsHome(t);
  const catalog = catalogOf([skill('card-analysis'), skill('notes')]);
  run(root, catalog);
  const enablement = enablementOf(['card-analysis']);

  assert.deepEqual(run(root, catalog, { enablement }), { ...NOTHING, removed: ['mittr-card-analysis'] });
  assert.deepEqual(run(root, catalog, { enablement }), NOTHING);
  assert.equal(exists(root, 'mittr-card-analysis'), false);
  assert.equal(exists(root, 'mittr-notes', 'SKILL.md'), true);

  assert.deepEqual(run(root, catalog), { ...NOTHING, installed: ['mittr-card-analysis'] });
  untouched();
});

test('an unconfigured collection keeps the account\'s installed skills', (t) => {
  const { root, untouched } = skillsHome(t);
  run(root, catalogOf([skill('card-analysis')]));

  assert.deepEqual(run(root, catalogOf([], { configured: false })), NOTHING);
  assert.deepEqual(run(root, { bundleVersion: 2 }), NOTHING);
  assert.deepEqual(run(root, null), NOTHING);
  assert.equal(exists(root, 'mittr-card-analysis', 'SKILL.md'), true);
  assert.equal(read(root, '.mittr-account').trim(), KEY_A);
  untouched();
});

test('switching to another account replaces the set even when its catalog has no skills key', (t) => {
  const { root, untouched } = skillsHome(t);
  run(root, catalogOf([skill('card-analysis')]), { accountKey: KEY_A });

  const result = run(root, { bundleVersion: 3, models: { configured: true, items: [] } }, { accountKey: KEY_B });

  assert.deepEqual(result, { ...NOTHING, removed: ['mittr-card-analysis'] });
  assert.deepEqual(entries(root), ['mine', 'mittr-mine']);
  untouched();
});

test('two accounts with different keys never share a set, even for a skill of the same name and version', (t) => {
  const { root, untouched } = skillsHome(t);
  run(root, catalogOf([skill('card-analysis', '1.0.0', [{ path: 'SKILL.md', content: skillText('card-analysis', 'A version') }])]), { accountKey: KEY_A });

  const result = run(root, catalogOf([skill('card-analysis', '1.0.0'), skill('notes')]), { accountKey: KEY_B });

  assert.deepEqual(result, { ...NOTHING, removed: ['mittr-card-analysis'], installed: ['mittr-card-analysis', 'mittr-notes'] });
  assert.equal(read(root, 'mittr-card-analysis', 'SKILL.md'), skillText('mittr-card-analysis', 'Body 1.0.0'));
  assert.equal(read(root, '.mittr-account').trim(), KEY_B);
  untouched();
});

test('org skills found without an account marker are not trusted to be this account\'s', (t) => {
  const { root, untouched } = skillsHome(t);
  run(root, catalogOf([skill('card-analysis')]));
  nodeFs.rmSync(path.join(root, '.mittr-account'));

  const result = run(root, catalogOf([skill('card-analysis')]));

  assert.deepEqual(result, { ...NOTHING, removed: ['mittr-card-analysis'], installed: ['mittr-card-analysis'] });
  assert.equal(read(root, '.mittr-account').trim(), KEY_A);
  untouched();
});

test('no account removes every org skill', (t) => {
  const { root, untouched } = skillsHome(t);
  const catalog = catalogOf([skill('card-analysis'), skill('notes')]);
  run(root, catalog);

  const result = run(root, catalog, { accountKey: null });

  assert.deepEqual(result, { ...NOTHING, removed: ['mittr-card-analysis', 'mittr-notes'] });
  assert.deepEqual(entries(root), ['mine', 'mittr-mine']);
  untouched();
});

test('no account and nothing installed writes nothing, not even the skills folder', (t) => {
  const root = path.join(tempDataDir(t), 'opencode', 'skills');
  assert.deepEqual(run(root, catalogOf([skill('card-analysis')]), { accountKey: null }), NOTHING);
  assert.deepEqual(run(root, catalogOf([]), { accountKey: KEY_A }), NOTHING);
  assert.equal(nodeFs.existsSync(root), false);
});

test('without a skills folder to manage nothing is done', () => {
  assert.deepEqual(reconcileSkills({ catalog: catalogOf([skill('card-analysis')]), enablement: allEnabled, skillsRoot: null, accountKey: KEY_A }), NOTHING);
});

test('a file path that leaves the skill is refused and nothing of that skill is written', (t) => {
  for (const bad of ['../x.md', '/etc/x.md', '.hidden/x.md', 'x.sh', 'a/../x.md', './x.md', 'a\\x.md', 'refs/SKILL.md', 'refs/skill.md', 'skill.md', 'SKILL.MD', 'C:/x.md', 'C:x.md', 'x.md:s.md', 'a\0.md']) {
    const { root, untouched } = skillsHome(t);
    const result = run(root, catalogOf([
      skill('bad', '1', [{ path: 'SKILL.md', content: skillText('bad') }, { path: bad, content: 'escape' }]),
      skill('good'),
    ]));

    assert.deepEqual(result, { ...NOTHING, installed: ['mittr-good'] }, bad);
    assert.deepEqual(entries(root), ['.mittr-account', 'mine', 'mittr-good', 'mittr-mine'], bad);
    assert.equal(nodeFs.existsSync(path.join(path.dirname(root), 'x.md')), false, bad);
    untouched();
  }
});

test('two files whose paths differ only in case refuse the whole skill', (t) => {
  const { root, untouched } = skillsHome(t);
  const result = run(root, catalogOf([
    skill('bad', '1', [{ path: 'SKILL.md', content: skillText('bad') }, { path: 'refs/notes.md', content: 'a' }, { path: 'Refs/Notes.md', content: 'b' }]),
    skill('twice', '1', [{ path: 'SKILL.md', content: skillText('twice') }, { path: 'SKILL.md', content: skillText('again') }]),
    skill('good'),
  ]));

  assert.deepEqual(result, { ...NOTHING, installed: ['mittr-good'] });
  assert.deepEqual(entries(root), ['.mittr-account', 'mine', 'mittr-good', 'mittr-mine']);
  untouched();
});

test('a developer\'s own skills beside the org skills are never touched', (t) => {
  const { root, untouched } = skillsHome(t);
  nodeFs.writeFileSync(path.join(root, 'loose.md'), 'loose');
  nodeFs.mkdirSync(path.join(root, 'mittr-target'));
  nodeFs.writeFileSync(path.join(root, 'mittr-target', 'SKILL.md'), 'target');
  const elsewhere = path.join(path.dirname(root), 'elsewhere');
  nodeFs.mkdirSync(elsewhere);
  nodeFs.writeFileSync(path.join(elsewhere, 'SKILL.md'), 'linked');
  nodeFs.writeFileSync(path.join(elsewhere, '.mittr-version'), '1.0.0\n');
  nodeFs.symlinkSync(elsewhere, path.join(root, 'mittr-linked'));

  run(root, catalogOf([skill('card-analysis')]));
  run(root, catalogOf([]));
  run(root, catalogOf([skill('card-analysis')]), { accountKey: KEY_B });
  run(root, null, { accountKey: null });

  assert.equal(read(root, 'loose.md'), 'loose');
  assert.equal(read(root, 'mittr-target', 'SKILL.md'), 'target');
  assert.equal(nodeFs.lstatSync(path.join(root, 'mittr-linked')).isSymbolicLink(), true);
  assert.equal(read(elsewhere, 'SKILL.md'), 'linked');
  assert.deepEqual(entries(root), ['loose.md', 'mine', 'mittr-linked', 'mittr-mine', 'mittr-target']);
  untouched();
});

test('a catalog skill whose folder a developer already owns is skipped and reported', (t) => {
  const { root, untouched } = skillsHome(t);

  const result = run(root, catalogOf([skill('mine'), skill('notes')]));

  assert.deepEqual(result.installed, ['mittr-notes']);
  assert.deepEqual(result.failed.map((failure) => failure.name), ['mittr-mine']);
  assert.match(result.failed[0].error, /not from the Mittr catalog/);
  untouched();
});

test('a failed write leaves the previous version in place', (t) => {
  const { root, untouched } = skillsHome(t);
  run(root, catalogOf([skill('card-analysis', '1.0.0'), skill('notes', '1.0.0')]));
  const failing = {
    ...nodeFs,
    writeFileSync: (target, ...rest) => {
      if (String(target).includes('.mittr-staging-mittr-card-analysis')) throw new Error('disk full');
      return nodeFs.writeFileSync(target, ...rest);
    },
  };

  const result = run(root, catalogOf([skill('card-analysis', '2.0.0'), skill('notes', '2.0.0')]), { fs: failing });

  assert.deepEqual(result.updated, ['mittr-notes']);
  assert.deepEqual(result.failed, [{ name: 'mittr-card-analysis', error: 'disk full' }]);
  assert.equal(read(root, 'mittr-card-analysis', '.mittr-version').trim(), '1.0.0');
  assert.equal(read(root, 'mittr-card-analysis', 'SKILL.md'), skillText('mittr-card-analysis', 'Body 1.0.0'));
  assert.deepEqual(entries(root), ['.mittr-account', 'mine', 'mittr-card-analysis', 'mittr-mine', 'mittr-notes']);
  untouched();
});

test('a swap that fails puts the previous version back', (t) => {
  const { root, untouched } = skillsHome(t);
  run(root, catalogOf([skill('card-analysis', '1.0.0')]));
  const failing = {
    ...nodeFs,
    renameSync: (from, to) => {
      if (String(from).includes('.mittr-staging-')) throw new Error('rename refused');
      return nodeFs.renameSync(from, to);
    },
  };

  const result = run(root, catalogOf([skill('card-analysis', '2.0.0')]), { fs: failing });

  assert.deepEqual(result.failed, [{ name: 'mittr-card-analysis', error: 'rename refused' }]);
  assert.equal(read(root, 'mittr-card-analysis', '.mittr-version').trim(), '1.0.0');
  assert.deepEqual(entries(root), ['.mittr-account', 'mine', 'mittr-card-analysis', 'mittr-mine']);
  untouched();
});

test('another account\'s skill that cannot be removed is never taken as this account\'s', (t) => {
  const { root, untouched } = skillsHome(t);
  run(root, catalogOf([skill('card-analysis'), skill('notes')]), { accountKey: KEY_A });
  const stuck = path.join(root, 'mittr-card-analysis');
  const failing = {
    ...nodeFs,
    rmSync: (target, options) => {
      if (target === stuck) throw new Error('busy');
      return nodeFs.rmSync(target, options);
    },
  };

  const result = run(root, catalogOf([skill('card-analysis'), skill('planning')]), { accountKey: KEY_B, fs: failing });

  assert.deepEqual({ ...result, failed: [] }, { installed: ['mittr-planning'], updated: [], removed: ['mittr-notes'], failed: [] });
  assert.deepEqual(result.failed.map((failure) => failure.name), ['mittr-card-analysis']);
  assert.match(result.failed[0].error, /^another account's catalog skill could not be removed.*: busy$/);
  assert.equal(exists(root, '.mittr-account'), false);
  assert.equal(read(root, 'mittr-card-analysis', '.mittr-version').trim(), '1.0.0');

  const retried = run(root, catalogOf([skill('card-analysis'), skill('planning')]), { accountKey: KEY_B });
  assert.deepEqual(retried, { installed: ['mittr-card-analysis', 'mittr-planning'], updated: [], removed: ['mittr-card-analysis', 'mittr-planning'], failed: [] });
  assert.equal(read(root, '.mittr-account').trim(), KEY_B);
  untouched();
});

test('what an interrupted run left behind is cleared, and nothing else', (t) => {
  const { root, untouched } = skillsHome(t);
  for (const leftover of ['.mittr-staging-mittr-x-abc123', '.mittr-old-mittr-y-def456']) {
    nodeFs.mkdirSync(path.join(root, leftover));
    nodeFs.writeFileSync(path.join(root, leftover, 'SKILL.md'), 'half');
  }
  nodeFs.mkdirSync(path.join(root, '.staging-other'));
  nodeFs.mkdirSync(path.join(workOf(root), '.mittr-staging-mittr-z-abc123'), { recursive: true });

  run(root, catalogOf([]));

  assert.deepEqual(entries(root), ['.staging-other', 'mine', 'mittr-mine']);
  assert.equal(nodeFs.existsSync(workOf(root)), false);
  untouched();
});

test('staging happens beside the skills folder, so nothing half-written is ever under it', (t) => {
  const { root, untouched } = skillsHome(t);
  run(root, catalogOf([skill('card-analysis', '1.0.0')]));
  const seen = [];
  const look = () => seen.push(...nodeFs.readdirSync(root).filter((name) => name.startsWith('.mittr-') && name !== '.mittr-account'));
  const watching = {
    ...nodeFs,
    writeFileSync: (target, ...rest) => {
      look();
      if (String(target).includes('mittr-notes')) throw new Error('disk full');
      return nodeFs.writeFileSync(target, ...rest);
    },
    renameSync: (from, to) => {
      look();
      assert.equal(path.dirname(from) === workOf(root) || path.dirname(to) === workOf(root), true);
      return nodeFs.renameSync(from, to);
    },
  };

  const result = run(root, catalogOf([skill('card-analysis', '2.0.0'), skill('notes')]), { fs: watching });

  assert.deepEqual(result.updated, ['mittr-card-analysis']);
  assert.deepEqual(result.failed.map((failure) => failure.name), ['mittr-notes']);
  assert.deepEqual(seen, []);
  assert.deepEqual(entries(root), ['.mittr-account', 'mine', 'mittr-card-analysis', 'mittr-mine']);
  assert.equal(nodeFs.existsSync(workOf(root)), false);
  untouched();
});

test('a skills folder on another device stages inside it instead', (t) => {
  const { root, untouched } = skillsHome(t);
  const stagedIn = [];
  const otherDevice = {
    ...nodeFs,
    statSync: (target, ...rest) => {
      const stat = nodeFs.statSync(target, ...rest);
      return target === workOf(root) ? { dev: stat.dev + 1 } : stat;
    },
    mkdtempSync: (prefix, ...rest) => {
      stagedIn.push(path.dirname(prefix));
      return nodeFs.mkdtempSync(prefix, ...rest);
    },
  };

  run(root, catalogOf([skill('card-analysis', '1.0.0')]), { fs: otherDevice });
  const result = run(root, catalogOf([skill('card-analysis', '2.0.0')]), { fs: otherDevice });

  assert.deepEqual(result, { ...NOTHING, updated: ['mittr-card-analysis'] });
  assert.deepEqual(stagedIn, [root, root]);
  assert.deepEqual(entries(root), ['.mittr-account', 'mine', 'mittr-card-analysis', 'mittr-mine']);
  assert.equal(nodeFs.existsSync(workOf(root)), false);
  untouched();
});

test('a set-aside folder that cannot be cleared does not fail an update that is in place', (t) => {
  const { root, untouched } = skillsHome(t);
  run(root, catalogOf([skill('card-analysis', '1.0.0')]));
  const stubborn = {
    ...nodeFs,
    rmSync: (target, options) => {
      if (path.basename(String(target)).startsWith('.mittr-old-')) throw new Error('busy');
      return nodeFs.rmSync(target, options);
    },
  };

  const result = run(root, catalogOf([skill('card-analysis', '2.0.0')]), { fs: stubborn });

  assert.deepEqual(result, { ...NOTHING, updated: ['mittr-card-analysis'] });
  assert.equal(read(root, 'mittr-card-analysis', '.mittr-version').trim(), '2.0.0');
  run(root, catalogOf([skill('card-analysis', '2.0.0')]));
  assert.equal(nodeFs.existsSync(workOf(root)), false);
  untouched();
});

test('a symlinked account marker counts as none and is replaced, never written through', (t) => {
  const { root, untouched } = skillsHome(t);
  const outside = path.join(path.dirname(root), 'outside.txt');
  nodeFs.writeFileSync(outside, KEY_A);
  nodeFs.symlinkSync(outside, path.join(root, '.mittr-account'));
  nodeFs.mkdirSync(path.join(root, 'mittr-old-set'));
  nodeFs.writeFileSync(path.join(root, 'mittr-old-set', '.mittr-version'), '1\n');

  const result = run(root, catalogOf([skill('card-analysis')]), { accountKey: KEY_A });

  assert.deepEqual(result, { ...NOTHING, removed: ['mittr-old-set'], installed: ['mittr-card-analysis'] });
  assert.equal(nodeFs.readFileSync(outside, 'utf8'), KEY_A);
  assert.equal(nodeFs.lstatSync(path.join(root, '.mittr-account')).isFile(), true);
  assert.equal(read(root, '.mittr-account').trim(), KEY_A);
  untouched();
});

test('1.22\'s org skills under mittr/ are removed on every run, whatever the account', (t) => {
  for (const accountKey of [KEY_A, null]) {
    const { root, untouched } = skillsHome(t);
    const legacy = path.join(root, 'mittr');
    for (const name of ['card-analysis', '.staging-notes-abc']) {
      nodeFs.mkdirSync(path.join(legacy, name), { recursive: true });
      nodeFs.writeFileSync(path.join(legacy, name, 'SKILL.md'), 'old');
      nodeFs.writeFileSync(path.join(legacy, name, '.mittr-version'), '1\n');
    }

    const result = run(root, catalogOf([]), { accountKey });

    assert.deepEqual(result.removed.sort(), ['mittr/.staging-notes-abc', 'mittr/card-analysis'], String(accountKey));
    assert.equal(nodeFs.existsSync(legacy), false, String(accountKey));
    untouched();
  }
});

test('a developer\'s own entries in mittr/ keep it, and only 1.22\'s skills go', (t) => {
  const { root, untouched } = skillsHome(t);
  const legacy = path.join(root, 'mittr');
  nodeFs.mkdirSync(path.join(legacy, 'card-analysis'), { recursive: true });
  nodeFs.writeFileSync(path.join(legacy, 'card-analysis', '.mittr-version'), '1\n');
  nodeFs.mkdirSync(path.join(legacy, 'my-skill'));
  nodeFs.writeFileSync(path.join(legacy, 'my-skill', 'SKILL.md'), 'mine');
  nodeFs.writeFileSync(path.join(legacy, 'notes.md'), 'notes');
  nodeFs.mkdirSync(path.join(legacy, 'linked-version'));
  nodeFs.symlinkSync(path.join(legacy, 'notes.md'), path.join(legacy, 'linked-version', '.mittr-version'));
  const elsewhere = path.join(path.dirname(root), 'elsewhere');
  nodeFs.mkdirSync(elsewhere);
  nodeFs.writeFileSync(path.join(elsewhere, '.mittr-version'), '1\n');
  nodeFs.symlinkSync(elsewhere, path.join(legacy, 'linked'));

  const result = run(root, catalogOf([]));

  assert.deepEqual(result.removed, ['mittr/card-analysis']);
  assert.deepEqual(nodeFs.readdirSync(legacy).sort(), ['linked', 'linked-version', 'my-skill', 'notes.md']);
  assert.equal(read(legacy, 'my-skill', 'SKILL.md'), 'mine');
  assert.equal(read(elsewhere, '.mittr-version'), '1\n');
  untouched();
});

test('an unreadable mittr/ is reported, and the rest of the run still happens', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, (t) => {
  const { root, untouched } = skillsHome(t);
  run(root, catalogOf([skill('card-analysis')]), { accountKey: KEY_A });
  const legacy = path.join(root, 'mittr');
  nodeFs.mkdirSync(path.join(legacy, 'notes'), { recursive: true });
  nodeFs.writeFileSync(path.join(legacy, 'notes', '.mittr-version'), '1\n');
  nodeFs.chmodSync(legacy, 0o000);
  let result;
  try {
    result = run(root, catalogOf([skill('planning')]), { accountKey: KEY_B });
  } finally {
    nodeFs.chmodSync(legacy, 0o755);
  }

  assert.deepEqual(result.removed, ['mittr-card-analysis']);
  assert.deepEqual(result.installed, ['mittr-planning']);
  assert.deepEqual(result.failed.map((failure) => failure.name), ['mittr']);
  assert.match(result.failed[0].error, /EACCES/);
  assert.equal(read(root, '.mittr-account').trim(), KEY_B);
  assert.equal(nodeFs.existsSync(path.join(legacy, 'notes', '.mittr-version')), true);
  untouched();
});

test('an empty mittr/ is removed, and a mittr file or link is left alone', (t) => {
  const { root, untouched } = skillsHome(t);
  nodeFs.mkdirSync(path.join(root, 'mittr'));
  run(root, catalogOf([]));
  assert.equal(nodeFs.existsSync(path.join(root, 'mittr')), false);

  const elsewhere = path.join(path.dirname(root), 'elsewhere');
  nodeFs.mkdirSync(path.join(elsewhere, 'card-analysis'), { recursive: true });
  nodeFs.writeFileSync(path.join(elsewhere, 'card-analysis', '.mittr-version'), '1\n');
  nodeFs.symlinkSync(elsewhere, path.join(root, 'mittr'));
  run(root, catalogOf([]));
  assert.equal(nodeFs.lstatSync(path.join(root, 'mittr')).isSymbolicLink(), true);
  assert.equal(nodeFs.existsSync(path.join(elsewhere, 'card-analysis', '.mittr-version')), true);
  untouched();
});

test('a catalog skill needs a plain name, a version and a SKILL.md of text files', () => {
  const files = [{ path: 'SKILL.md', content: 'x' }];
  assert.deepEqual(parseCatalogSkill({ name: ' card-analysis ', version: ' 1.0 ', files }), { name: 'card-analysis', version: '1.0', files });
  assert.deepEqual(parseCatalogSkill({ name: 'a', version: '1', files: [...files, { path: 'refs/b.yaml', content: 'y' }] }).files.map((file) => file.path), ['SKILL.md', 'refs/b.yaml']);
  for (const item of [
    null,
    [],
    'card',
    { name: 'Card', version: '1', files },
    { name: 'card_analysis', version: '1', files },
    { name: '-card', version: '1', files },
    { name: 'card', version: '', files },
    { name: 'card', files },
    { name: 'card', version: '1', files: 'SKILL.md' },
    { name: 'card', version: '1', files: [{ path: 'README.md', content: 'x' }] },
    { name: 'card', version: '1', files: [{ path: 'SKILL.md', content: 7 }] },
    { name: 'card', version: '1', files: [...files, null] },
  ]) {
    assert.equal(parseCatalogSkill(item), null, JSON.stringify(item));
  }
});
