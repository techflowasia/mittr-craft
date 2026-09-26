#!/usr/bin/env node
// Builds the MittrCraft engine: upstream at a pinned tag, plus our patch set.
//
// The patch set is deliberately thin — identity strings and the project
// directory name — so that moving to a newer upstream tag stays a cheap,
// mechanical step rather than a merge. If applying a patch ever conflicts, that
// is the signal to look at what upstream changed, not to force it through.
//
// Usage:
//   node scripts/build-engine.mjs [--version <tag>] [--work <dir>] [--skip-clone]
//
// Output: <work>/opencode/packages/opencode/dist/opencode-<platform>/bin/opencode

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPSTREAM_REPO = 'https://github.com/anomalyco/opencode.git';

const readFlag = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const pinnedVersion = readFileSync(path.join(repoRoot, 'engine', 'UPSTREAM_VERSION'), 'utf8').trim();
const version = readFlag('--version', pinnedVersion);
const workDir = path.resolve(readFlag('--work', path.join(os.tmpdir(), 'mittrcraft-engine')));
const skipClone = process.argv.includes('--skip-clone');
// `--single` restricts the upstream script to the current platform. Dropping it
// builds all twelve targets, which Bun cross-compiles from one machine.
const buildArgs = process.argv.includes('--all') ? [] : ['--single'];
const sourceDir = path.join(workDir, 'opencode');

const run = (command, args, cwd) => {
  console.log(`+ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd, stdio: 'inherit' });
};

const patchFiles = () => {
  const dir = path.join(repoRoot, 'engine', 'patches');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.patch'))
    .sort()
    .map((name) => path.join(dir, name));
};

if (!skipClone) {
  if (existsSync(sourceDir)) {
    throw new Error(
      `${sourceDir} already exists. Remove it, or pass --skip-clone to build what is already there.`
    );
  }
  run('mkdir', ['-p', workDir]);
  // A shallow clone of one tag: the full history is ~500 MB and buys nothing here.
  run('git', ['clone', '--depth', '1', '--branch', `v${version}`, UPSTREAM_REPO, sourceDir]);
}

for (const patch of patchFiles()) {
  // --check first, so a conflict is reported before anything is half-applied.
  run('git', ['apply', '--check', patch], sourceDir);
  run('git', ['apply', patch], sourceDir);
}

run('bun', ['install'], sourceDir);
run('bun', ['run', '--cwd', 'packages/opencode', 'typecheck'], sourceDir);
// The build stamps whatever OPENCODE_VERSION says, and defaults to a 0.0.0
// development string. Stamping the upstream tag we built from keeps every
// version comparison downstream — the packaging check, the engine version shown
// in the UI — reading the number that actually describes protocol compatibility.
console.log(`+ ./packages/opencode/script/build.ts ${buildArgs.join(' ')}  (OPENCODE_VERSION=${version})`);
execFileSync('./packages/opencode/script/build.ts', buildArgs, {
  cwd: sourceDir,
  stdio: 'inherit',
  env: { ...process.env, OPENCODE_VERSION: version },
});

const platform = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
const distDir = path.join(sourceDir, 'packages', 'opencode', 'dist');
const binary = path.join(distDir, `opencode-${platform}`, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');

// The build script runs its own smoke test, but it tests the binary it just
// wrote — not that our patches took. Verifying the identity here is what makes
// a silently unpatched build impossible to ship.
const strings = execFileSync('strings', [binary], { maxBuffer: 1024 * 1024 * 512 }).toString();
const ours = (strings.match(/You are MittrCraft/g) ?? []).length;
const upstream = (strings.match(/You are [Oo]pen[Cc]ode/g) ?? []).length;
if (ours === 0 || upstream > 0) {
  throw new Error(
    `Identity check failed: ${ours} MittrCraft, ${upstream} upstream. The patches did not take.`
  );
}
if (!strings.includes('.mittr')) {
  throw new Error('Project directory check failed: .mittr is absent from the binary.');
}

console.log(`\nBuilt ${binary}`);
console.log(`Identity: ${ours} MittrCraft, ${upstream} upstream.`);

// Only the targets the desktop actually ships. The names and formats are what
// packages/electron/scripts/prepare-opencode-cli.mjs expects to download, so
// these files can be attached to a release and fetched unchanged.
//
// Windows arm64 is absent on purpose: it ships the x64 baseline build while an
// upstream arm64 defect is open.
const RELEASE_TARGETS = [
  { target: 'opencode-darwin-arm64', asset: 'mittrcraft-engine-darwin-arm64.zip' },
  { target: 'opencode-darwin-x64-baseline', asset: 'mittrcraft-engine-darwin-x64-baseline.zip' },
  { target: 'opencode-windows-x64-baseline', asset: 'mittrcraft-engine-windows-x64-baseline.zip' },
  { target: 'opencode-linux-x64-baseline', asset: 'mittrcraft-engine-linux-x64-baseline.tar.gz' },
  { target: 'opencode-linux-arm64', asset: 'mittrcraft-engine-linux-arm64.tar.gz' },
];

if (process.argv.includes('--all')) {
  const assetDir = path.join(workDir, 'assets');
  rmSync(assetDir, { recursive: true, force: true });
  mkdirSync(assetDir, { recursive: true });

  for (const { target, asset } of RELEASE_TARGETS) {
    const targetDir = path.join(distDir, target);
    if (!existsSync(targetDir)) {
      throw new Error(`Expected ${target} in ${distDir}. The build did not produce every shipped target.`);
    }
    const output = path.join(assetDir, asset);
    // Archive the bin/ directory itself, so the layout matches what the
    // packaging step's findBinary() walks.
    if (asset.endsWith('.zip')) {
      execFileSync('zip', ['-q', '-r', output, 'bin'], { cwd: targetDir, stdio: 'inherit' });
    } else {
      execFileSync('tar', ['-czf', output, 'bin'], { cwd: targetDir, stdio: 'inherit' });
    }
    console.log(`packaged ${asset}`);
  }

  console.log(`\nRelease assets in ${assetDir}`);
  console.log(`Attach them to a release tagged engine-v${version} on this repository.`);
}
