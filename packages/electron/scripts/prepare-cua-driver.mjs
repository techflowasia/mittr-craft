import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Vendors the `cua-driver` binary (github.com/trycua/cua, MIT) the same way
// prepare-opencode-cli.mjs vendors the engine: pin a version, download once, cache,
// verify, copy into resources/. macOS ships it as CuaDriver.app because Accessibility
// and Screen Recording TCC grants are tied to that app's own code-signing identity —
// re-signing it under Mitr's own identity so the OS permission dialog reads "MittrCraft"
// instead of "CuaDriver" is NOT done here, and needs the same notarization pipeline
// MittrCraft.app itself already goes through. Windows/Linux artifacts are not mapped yet.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(__dirname, '..');
const outputDir = path.join(electronRoot, 'resources', 'cua-driver');
const cacheRoot = path.join(electronRoot, '.cache', 'cua-driver');

const CUA_DRIVER_VERSION = '0.28.2';

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    windowsHide: true,
    ...options,
  });
  if (result.status !== 0) {
    const stderr = result.stderr ? `\n${result.stderr.trim()}` : '';
    const stdout = result.stdout ? `\n${result.stdout.trim()}` : '';
    throw new Error(`Command failed: ${command} ${args.join(' ')}${stderr}${stdout}`);
  }
  return result;
};

const download = async (url, destination) => {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  const temp = `${destination}.tmp`;
  fs.writeFileSync(temp, Buffer.from(await response.arrayBuffer()));
  fs.renameSync(temp, destination);
};

const extractTarGz = (archivePath, destination) => {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  run('tar', ['-xzf', archivePath, '-C', destination]);
};

const findEntry = (root, name) => {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.name === name) return fullPath;
    if (entry.isDirectory()) {
      const found = findEntry(fullPath, name);
      if (found) return found;
    }
  }
  return null;
};

const readVersion = (cliPath) => {
  if (!fs.existsSync(cliPath)) return null;
  const result = spawnSync(cliPath, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
  });
  if (result.status !== 0) return null;
  return (result.stdout || '').trim().split(/\s+/)[1] || null;
};

const main = async () => {
  if (process.platform !== 'darwin') {
    // `package` runs this on every platform's CI job — Windows/Linux artifact names
    // aren't mapped yet, so skip rather than fail the whole packaging pipeline over
    // a feature that isn't wired up for those platforms yet.
    console.log(
      `[electron] skipping cua-driver bundling on ${process.platform} — only darwin is mapped so far`,
    );
    return;
  }

  const outputCli = path.join(outputDir, 'cua-driver');
  const existing = readVersion(outputCli);
  if (existing === CUA_DRIVER_VERSION) {
    console.log(`[electron] bundled cua-driver already prepared: ${outputCli} (${existing})`);
    return;
  }

  const artifactName = `cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-universal.tar.gz`;
  const cacheDir = path.join(cacheRoot, CUA_DRIVER_VERSION);
  const archivePath = path.join(cacheDir, artifactName);
  const url = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}/${artifactName}`;

  if (!fs.existsSync(archivePath)) {
    console.log(`[electron] downloading cua-driver ${CUA_DRIVER_VERSION}: ${artifactName}`);
    await download(url, archivePath);
  } else {
    console.log(`[electron] using cached cua-driver archive: ${archivePath}`);
  }

  const extractDir = path.join(cacheDir, 'extract');
  extractTarGz(archivePath, extractDir);

  const appBundle = findEntry(extractDir, 'CuaDriver.app');
  if (!appBundle) {
    throw new Error(`Archive ${archivePath} did not contain CuaDriver.app`);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  for (const entry of fs.readdirSync(outputDir)) {
    if (entry === '.gitkeep') continue;
    fs.rmSync(path.join(outputDir, entry), { recursive: true, force: true });
  }
  fs.cpSync(appBundle, path.join(outputDir, 'CuaDriver.app'), { recursive: true });
  fs.symlinkSync(
    './CuaDriver.app/Contents/MacOS/cua-driver',
    path.join(outputDir, 'cua-driver'),
  );

  const preparedVersion = readVersion(outputCli);
  if (preparedVersion !== CUA_DRIVER_VERSION) {
    throw new Error(
      `Prepared cua-driver version mismatch: expected ${CUA_DRIVER_VERSION}, got ${preparedVersion || 'unknown'}`,
    );
  }

  console.log(`[electron] prepared cua-driver ${CUA_DRIVER_VERSION}: ${outputCli}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
