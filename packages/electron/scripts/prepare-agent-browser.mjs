import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Vendors the `agent-browser` CLI (github.com/vercel-labs/agent-browser, Apache-2.0)
// the same way prepare-cua-driver.mjs vendors its driver: pin a version, download
// the single native binary once, cache it, verify it, copy it into resources/.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(__dirname, '..');
const outputDir = path.join(electronRoot, 'resources', 'agent-browser');
const cacheRoot = path.join(electronRoot, '.cache', 'agent-browser');

const AGENT_BROWSER_VERSION = '0.38.1';
const ARCH_ASSETS = { arm64: 'agent-browser-darwin-arm64', x64: 'agent-browser-darwin-x64' };

const readVersion = (binary) => {
  if (!fs.existsSync(binary)) return null;
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) return null;
  return (result.stdout || '').trim().split(/\s+/)[1] || null;
};

const download = async (url, destination) => {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  const temp = `${destination}.tmp`;
  fs.writeFileSync(temp, Buffer.from(await response.arrayBuffer()));
  fs.renameSync(temp, destination);
};

const main = async () => {
  if (process.platform !== 'darwin') {
    console.log(`[electron] skipping agent-browser bundling on ${process.platform} — only darwin is mapped so far`);
    return;
  }
  const asset = ARCH_ASSETS[process.arch];
  if (!asset) throw new Error(`No agent-browser asset for arch ${process.arch}`);

  const output = path.join(outputDir, 'agent-browser');
  if (readVersion(output) === AGENT_BROWSER_VERSION) {
    console.log(`[electron] bundled agent-browser already prepared: ${output} (${AGENT_BROWSER_VERSION})`);
    return;
  }

  const cached = path.join(cacheRoot, AGENT_BROWSER_VERSION, asset);
  if (!fs.existsSync(cached)) {
    const url = `https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}/${asset}`;
    console.log(`[electron] downloading agent-browser ${AGENT_BROWSER_VERSION}: ${asset}`);
    await download(url, cached);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  fs.copyFileSync(cached, output);
  fs.chmodSync(output, 0o755);

  const version = readVersion(output);
  if (version !== AGENT_BROWSER_VERSION) {
    throw new Error(`Bundled agent-browser reports ${version ?? 'nothing'}, expected ${AGENT_BROWSER_VERSION}`);
  }
  console.log(`[electron] bundled agent-browser ${version}: ${output}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
