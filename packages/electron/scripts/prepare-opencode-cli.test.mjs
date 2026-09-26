import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, 'prepare-opencode-cli.mjs');
const outputDir = path.join(here, '..', 'resources', 'opencode-cli');

const pinnedVersion = () => {
  const root = path.join(here, '..', '..', '..', 'package.json');
  return JSON.parse(fs.readFileSync(root, 'utf8')).dependencies['@opencode-ai/sdk'];
};

// The script only ever asks the engine for --version, so a shell script is a
// faithful stand-in and keeps the test off the network.
const fakeEngine = (dir, version) => {
  const file = path.join(dir, 'engine');
  fs.writeFileSync(file, `#!/bin/sh\necho "${version}"\n`, { mode: 0o755 });
  return file;
};

const withScratch = async (body) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-prepare-'));
  // Preserve whatever the working copy had, so running tests never quietly
  // replaces an engine somebody already prepared.
  const saved = fs.existsSync(outputDir)
    ? fs.readdirSync(outputDir).map((name) => [
      name,
      fs.readFileSync(path.join(outputDir, name)),
      // The mode travels with the bytes. The engine is staged executable, and
      // a restore that writes the content alone hands back a file the packaged
      // app cannot run -- a test leaving the working copy broken behind it.
      fs.statSync(path.join(outputDir, name)).mode,
    ])
    : [];
  // Start from an empty staging directory. Preserving the working copy is not
  // the same as clearing it, and the script returns early when a prepared
  // engine of the pinned version is already there -- so on any machine that
  // had packaged once, these tests asserted against that early return instead
  // of the branch they name, and passed only where nobody had built.
  if (fs.existsSync(outputDir)) {
    for (const name of fs.readdirSync(outputDir)) fs.rmSync(path.join(outputDir, name), { force: true });
  }
  try {
    await body(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (fs.existsSync(outputDir)) {
      for (const name of fs.readdirSync(outputDir)) fs.rmSync(path.join(outputDir, name), { force: true });
    }
    for (const [name, body, mode] of saved) {
      const restored = path.join(outputDir, name);
      fs.writeFileSync(restored, body);
      fs.chmodSync(restored, mode);
    }
  }
};

const runScript = (env) => spawnSync(process.execPath, [scriptPath], {
  encoding: 'utf8',
  env: { ...process.env, ...env },
  timeout: 60000,
});

test('installs a locally built engine instead of downloading', async () => {
  await withScratch(async (tmp) => {
    const result = runScript({ MITTRCRAFT_ENGINE_BINARY: fakeEngine(tmp, pinnedVersion()) });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /using locally built engine/);
    assert.doesNotMatch(result.stdout, /downloading/);
  });
});

test('still verifies the version, so a mismatched build is caught', async () => {
  await withScratch(async (tmp) => {
    const result = runScript({ MITTRCRAFT_ENGINE_BINARY: fakeEngine(tmp, '0.0.0--202601010000') });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /version mismatch/i);
  });
});

test('fails loudly when the provided path does not exist', async () => {
  await withScratch(async (tmp) => {
    const result = runScript({ MITTRCRAFT_ENGINE_BINARY: path.join(tmp, 'absent') });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /does not exist/i);
  });
});
