import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveTargetArchitecture } from './target-architecture.mjs';
import os from 'node:os';
import { DEEP_LINK_PROTOCOL } from '../deep-link-protocol.mjs';
import { resolveAppFlavor } from '../app-flavor.mjs';

const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/**
 * The build must declare the scheme the app registers at runtime.
 *
 * Nothing else catches this. `setAsDefaultProtocolClient` throws nothing when
 * the bundle declares no scheme -- on macOS it simply has nothing to bind to,
 * because LaunchServices only routes a scheme an app declares in its
 * Info.plist -- so a build with deep links entirely dead looks identical to a
 * working one until somebody clicks a link.
 */
const appFlavor = resolveAppFlavor(process.env.MITTRCRAFT_APP_FLAVOR);

const effectiveBuildConfig = () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (appFlavor.id === 'production') return manifest.build;
  return {
    ...manifest.build,
    appId: appFlavor.appId,
    productName: appFlavor.productName,
    protocols: [{ name: appFlavor.productName, schemes: [appFlavor.protocol] }],
  };
};

const writeFlavorConfig = () => {
  if (appFlavor.id === 'production') return null;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mittrcraft-flavor-')), 'electron-builder.json');
  fs.writeFileSync(file, JSON.stringify(effectiveBuildConfig(), null, 2));
  console.log(`[electron] building the ${appFlavor.productName} flavor (${appFlavor.appId}, scheme ${appFlavor.protocol})`);
  return file;
};

const assertProtocolDeclared = () => {
  const declared = (effectiveBuildConfig()?.protocols ?? []).flatMap((entry) => entry.schemes ?? []);
  if (!declared.includes(DEEP_LINK_PROTOCOL)) {
    throw new Error(
      `build.protocols does not declare "${DEEP_LINK_PROTOCOL}". `
      + 'The app registers that scheme at startup, so a build without it ships dead deep links.',
    );
  }
};

/**
 * And the produced bundle must actually carry it, which is a different claim
 * from the config declaring it: only the artifact proves electron-builder
 * wrote it through.
 */
const assertMacBundleDeclaresProtocol = () => {
  if (process.platform !== 'darwin') return;
  const appDir = path.join(packageRoot, 'dist', `mac-${targetArchitecture.electronBuilder}`);
  if (!fs.existsSync(appDir)) return;
  const bundle = fs.readdirSync(appDir).find((name) => name.endsWith('.app'));
  if (!bundle) return;
  const plist = path.join(appDir, bundle, 'Contents', 'Info.plist');
  const contents = fs.readFileSync(plist, 'utf8');
  if (!contents.includes(`<string>${DEEP_LINK_PROTOCOL}</string>`)) {
    throw new Error(`${plist} declares no CFBundleURLTypes entry for "${DEEP_LINK_PROTOCOL}".`);
  }
  console.log(`[electron] deep-link scheme "${DEEP_LINK_PROTOCOL}" declared in ${bundle}`);
};

const env = { ...process.env };
const builderArgs = process.argv.slice(2);
const targetArchitecture = resolveTargetArchitecture({ environment: env, builderArgs });

if (process.platform === 'win32' && !env.CSC_LINK && !env.WINDOWS_CSC_LINK) {
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  console.log('[electron] Windows code signing disabled; building unsigned installer.');
}

const bunBinaryCandidates = [
  process.env.npm_execpath,
  process.env.BUN_INSTALL ? path.join(process.env.BUN_INSTALL, 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun') : null,
  process.platform === 'win32' ? 'bun.exe' : 'bun',
].filter(Boolean);

const bunBinary = bunBinaryCandidates.find((candidate) => {
  if (path.basename(candidate).toLowerCase().startsWith('bun')) {
    return candidate === 'bun' || candidate === 'bun.exe' || fs.existsSync(candidate);
  }
  return false;
}) || (process.platform === 'win32' ? 'bun.exe' : 'bun');

if (process.platform === 'linux' && !builderArgs.some((argument) => (
  argument === '--x64' || argument === '--arm64' || argument === '--arch' || argument.startsWith('--arch=')
))) {
  builderArgs.push(`--${targetArchitecture.electronBuilder}`);
}

assertProtocolDeclared();

const flavorConfig = writeFlavorConfig();
if (flavorConfig) builderArgs.push('--config', flavorConfig);

const child = spawn(bunBinary, ['x', 'electron-builder', ...builderArgs], {
  env,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  if (code === 0) {
    try {
      assertMacBundleDeclaresProtocol();
    } catch (error) {
      console.error(`[electron] ${error.message}`);
      process.exit(1);
    }
  }
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error('[electron] failed to start electron-builder:', error);
  process.exit(1);
});
