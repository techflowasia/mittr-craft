import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { tempDataDir } from '../test-helpers.js';
import { commandFiles, fileFingerprint, filesUnchanged, fingerprintsOf } from './widget-files.js';

const CWD = '/work/app';

test('a command names the files it runs from its folder, and system programs are left out', () => {
  for (const [command, files] of [
    ['./status.sh', ['/work/app/status.sh']],
    ['scripts/check.sh --json', ['/work/app/scripts/check.sh']],
    ['FOO=1 ./status.sh | jq .state', ['/work/app/status.sh']],
    ['npm run status', ['/work/app/package.json']],
    ['pnpm status', ['/work/app/package.json']],
    ['yarn run build:status', ['/work/app/package.json']],
    ['bun run status', ['/work/app/package.json', '/work/app/status']],
    ['node check.js', ['/work/app/check.js']],
    ['node --no-warnings tools/check.mjs', ['/work/app/tools/check.mjs']],
    ['python3 -u check.py', ['/work/app/check.py']],
    ['bash -e status.sh', ['/work/app/status.sh']],
    ['sh -c "./inner.sh && echo done"', ['/work/app/inner.sh']],
    ['cd sub && ./run.sh; echo $(./count.sh)', ['/work/app/sub/count.sh', '/work/app/sub/run.sh']],
    ['make status', ['/work/app/GNUmakefile', '/work/app/Makefile', '/work/app/makefile']],
    ['env LANG=C ./status.sh', ['/work/app/status.sh']],
    ['~/bin/status.sh', [path.join(os.homedir(), 'bin/status.sh')]],
    ['curl -s https://acme.example.test/build | jq -r .state', []],
    ['/usr/bin/grep -c ok log.txt', []],
    ['python3 -c "print(1)"', []],
    ['node -e "console.log(1)"', []],
    ['echo "./not-run.sh"', []],
  ]) {
    assert.deepEqual(commandFiles(command, CWD), files, command);
  }
});

test('a git command watches the config of the repository its folder is in', (t) => {
  const repo = fs.realpathSync(tempDataDir(t));
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, 'sub'));
  assert.deepEqual(commandFiles('git log -1 --format=%s', path.join(repo, 'sub')), [path.join(repo, '.git', 'config')]);
});

test('a fingerprint follows the content, and a file that appears or goes away counts as a change', (t) => {
  const dir = fs.realpathSync(tempDataDir(t));
  const file = path.join(dir, 'status.sh');
  const before = fingerprintsOf([file]);
  assert.deepEqual(before, { [file]: null });
  assert.equal(filesUnchanged(before, [file]), true);
  fs.writeFileSync(file, 'echo ok');
  assert.equal(filesUnchanged(before, [file]), false);
  const written = fingerprintsOf([file]);
  assert.match(fileFingerprint(file), /^[0-9a-f]{64}$/);
  assert.equal(filesUnchanged(written, [file]), true);
  fs.writeFileSync(file, 'echo changed');
  assert.equal(filesUnchanged(written, [file]), false);
  assert.equal(filesUnchanged(written, []), false);
  assert.equal(filesUnchanged(undefined, []), true);
  assert.equal(filesUnchanged(undefined, [file]), false);
});
