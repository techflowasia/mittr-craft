import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AGENT_BROWSER_BINARY_ENV,
  CUA_DRIVER_ARCHIVE_ENV,
  NOTICES_RESOURCE,
  assertDriverArchitecture,
  checkDriverSources,
  checkNotices,
  driverSources,
  noticeLicenceText,
  noticeSection,
  readDriverPins,
  stageDrivers,
  verifyPackedDrivers,
} from './drivers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const scratch = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const machOArm64 = (label) => {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.write(label, 32);
  return bytes;
};

const fixtureDrivers = (t) => {
  const dir = scratch(t, 'drivers-fixture-');
  const agentBrowserBytes = machOArm64('fixture agent-browser');
  const agentBrowserBinary = path.join(dir, 'agent-browser-darwin-arm64');
  fs.writeFileSync(agentBrowserBinary, agentBrowserBytes, { mode: 0o644 });

  const top = 'cua-driver-rs-9.9.9-darwin-universal';
  const appDir = path.join(dir, 'tree', top, 'CuaDriver.app', 'Contents');
  fs.mkdirSync(path.join(appDir, 'MacOS'), { recursive: true });
  const cuaBinaryBytes = Buffer.from('fixture cua-driver binary');
  fs.writeFileSync(path.join(appDir, 'MacOS', 'cua-driver'), cuaBinaryBytes, { mode: 0o755 });
  fs.writeFileSync(path.join(appDir, 'Info.plist'), '<plist/>\n');
  const cuaArchive = path.join(dir, `${top}.tar.gz`);
  const tar = spawnSync('tar', ['-czf', cuaArchive, '-C', path.join(dir, 'tree'), top], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  const archiveBytes = fs.readFileSync(cuaArchive);

  const pins = {
    agentBrowser: {
      version: '9.8.7',
      asset: 'agent-browser-darwin-arm64',
      url: 'https://downloads.example.test/agent-browser-darwin-arm64',
      sha256: sha256(agentBrowserBytes),
      bytes: agentBrowserBytes.length,
      resignedStrippedSha256: 'a'.repeat(64),
      resignedStrippedBytes: 40,
      licence: 'Apache-2.0',
    },
    cuaDriver: {
      version: '9.9.9',
      asset: `${top}.tar.gz`,
      url: `https://downloads.example.test/${top}.tar.gz`,
      archiveSha256: sha256(archiveBytes),
      archiveBytes: archiveBytes.length,
      binarySha256: sha256(cuaBinaryBytes),
      bundleIdentifier: 'test.example.driver',
      teamIdentifier: 'TEAM000001',
      licence: 'MIT',
    },
  };
  return { dir, pins, agentBrowserBinary, cuaArchive };
};

const pinMessage = (pin, expected) => `${pin.asset} is missing or does not match scripts/mittr/drivers.json (expected sha256 ${expected}). Downloading it from ${pin.url} needs the owner's yes.`;

const okCodesign = (calls = []) => (args) => {
  calls.push(args);
  return { status: 0, stdout: '', stderr: '' };
};

test('the pin file holds the two drivers read from the local copies on 21 Oct', () => {
  const pins = readDriverPins();
  assert.equal(pins.agentBrowser.version, '0.38.1');
  assert.equal(pins.agentBrowser.sha256, '2e61287259053ea964d39e77002c6a34af0e589e55ccff25e659efae7e892e0d');
  assert.equal(pins.agentBrowser.bytes, 15768448);
  assert.equal(pins.cuaDriver.version, '0.28.2');
  assert.equal(pins.cuaDriver.archiveSha256, 'e273181b26709c88b1d809474deb3c592b4efae3530b11d76318f1887fc3fbb1');
  assert.equal(pins.cuaDriver.binarySha256, '9a7731f7e961a57963f0deb132878367fdf7354e7327a4d558fe4a68e4686b81');
  assert.equal(pins.cuaDriver.bundleIdentifier, 'com.trycua.driver');
  assert.equal(pins.cuaDriver.teamIdentifier, 'YCK386LBJ7');
});

test('sources come from the environment first, else the build cache', () => {
  const pins = readDriverPins();
  const fromCache = driverSources(pins, {});
  assert.equal(fromCache.agentBrowserBinary, path.join(repoRoot, 'packages/electron/.cache/agent-browser/0.38.1/agent-browser-darwin-arm64'));
  assert.equal(fromCache.cuaArchive, path.join(repoRoot, 'packages/electron/.cache/cua-driver/0.28.2/cua-driver-rs-0.28.2-darwin-universal.tar.gz'));
  const fromEnv = driverSources(pins, { [AGENT_BROWSER_BINARY_ENV]: '/x/ab', [CUA_DRIVER_ARCHIVE_ENV]: '/x/cua.tar.gz' });
  assert.deepEqual(fromEnv, { agentBrowserBinary: '/x/ab', cuaArchive: '/x/cua.tar.gz' });
});

test('a binary whose sha256 differs from the pin is refused with the exact message', (t) => {
  const { dir, pins, cuaArchive } = fixtureDrivers(t);
  const wrong = path.join(dir, 'wrong-agent-browser');
  fs.writeFileSync(wrong, machOArm64('another build'));
  const env = { [AGENT_BROWSER_BINARY_ENV]: wrong, [CUA_DRIVER_ARCHIVE_ENV]: cuaArchive };
  assert.throws(() => checkDriverSources({ pins, env }), { message: pinMessage(pins.agentBrowser, pins.agentBrowser.sha256) });
  assert.throws(
    () => stageDrivers({ pins, agentBrowserBinary: wrong, cuaArchive, outDir: path.join(dir, 'out'), codesign: okCodesign() }),
    { message: pinMessage(pins.agentBrowser, pins.agentBrowser.sha256) },
  );
  assert.equal(fs.existsSync(path.join(dir, 'out')), false);
});

test('a missing archive names the asset, the url and the owner\'s yes', (t) => {
  const { dir, pins, agentBrowserBinary } = fixtureDrivers(t);
  const missing = path.join(dir, 'nowhere.tar.gz');
  const env = { [AGENT_BROWSER_BINARY_ENV]: agentBrowserBinary, [CUA_DRIVER_ARCHIVE_ENV]: missing };
  assert.throws(() => checkDriverSources({ pins, env }), { message: pinMessage(pins.cuaDriver, pins.cuaDriver.archiveSha256) });
  const message = pinMessage(pins.cuaDriver, pins.cuaDriver.archiveSha256);
  assert.ok(message.includes(pins.cuaDriver.asset) && message.includes(pins.cuaDriver.url) && message.includes('owner\'s yes'));
});

test('staging writes agent-browser with mode 755 and the cua-driver link', (t) => {
  const { dir, pins, agentBrowserBinary, cuaArchive } = fixtureDrivers(t);
  const outDir = path.join(dir, 'out');
  const calls = [];
  const staged = stageDrivers({ pins, agentBrowserBinary, cuaArchive, outDir, codesign: okCodesign(calls) });

  assert.equal(staged.agentBrowser, path.join(outDir, 'agent-browser', 'agent-browser'));
  assert.equal(fs.statSync(staged.agentBrowser).mode & 0o777, 0o755);
  assert.equal(sha256(fs.readFileSync(staged.agentBrowser)), pins.agentBrowser.sha256);
  assert.equal(fs.statSync(agentBrowserBinary).mode & 0o777, 0o644);

  assert.equal(staged.cuaApp, path.join(outDir, 'cua-driver', 'CuaDriver.app'));
  assert.equal(staged.cuaDriver, path.join(outDir, 'cua-driver', 'cua-driver'));
  assert.equal(fs.lstatSync(staged.cuaDriver).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(staged.cuaDriver), './CuaDriver.app/Contents/MacOS/cua-driver');
  assert.equal(sha256(fs.readFileSync(staged.cuaDriver)), pins.cuaDriver.binarySha256);
  assert.deepEqual(calls, [['--verify', '--deep', '--strict', staged.cuaApp]]);
});

test('staging stops when the app in the archive is not the pinned build or fails its signature check', (t) => {
  const { dir, pins, agentBrowserBinary, cuaArchive } = fixtureDrivers(t);
  const outDir = path.join(dir, 'out');
  const otherBinary = { ...pins, cuaDriver: { ...pins.cuaDriver, binarySha256: 'b'.repeat(64) } };
  assert.throws(() => stageDrivers({ pins: otherBinary, agentBrowserBinary, cuaArchive, outDir, codesign: okCodesign() }), /CuaDriver\.app\/Contents\/MacOS\/cua-driver has sha256 [0-9a-f]{64}, not the pinned b{64}/);
  const badSignature = () => ({ status: 1, stdout: '', stderr: 'a sealed resource is missing or invalid' });
  assert.throws(() => stageDrivers({ pins, agentBrowserBinary, cuaArchive, outDir, codesign: badSignature }), /fails codesign --verify --deep --strict: a sealed resource is missing or invalid/);
  assert.equal(fs.existsSync(path.join(outDir, 'cua-driver')), false);
});

const packedApp = (t, pins, { teamIdentifier = pins.cuaDriver.teamIdentifier, notices = true } = {}) => {
  const dist = scratch(t, 'packed-drivers-');
  const resources = path.join(dist, 'Fixture Dev.app', 'Contents', 'Resources');
  fs.mkdirSync(path.join(resources, 'agent-browser'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'agent-browser', 'agent-browser'), machOArm64('fixture agent-browser'), { mode: 0o755 });
  const macos = path.join(resources, 'cua-driver', 'CuaDriver.app', 'Contents', 'MacOS');
  fs.mkdirSync(macos, { recursive: true });
  fs.writeFileSync(path.join(macos, 'cua-driver'), Buffer.from('fixture cua-driver binary'), { mode: 0o755 });
  fs.symlinkSync('./CuaDriver.app/Contents/MacOS/cua-driver', path.join(resources, 'cua-driver', 'cua-driver'));
  const noticesSource = path.join(dist, 'notices.md');
  fs.writeFileSync(noticesSource, '# Third-party notices\n');
  if (notices) fs.copyFileSync(noticesSource, path.join(resources, NOTICES_RESOURCE));
  const codesign = (args) => {
    if (args[0] === '-dv') {
      return { status: 0, stdout: '', stderr: `Executable=${args[1]}/Contents/MacOS/cua-driver\nIdentifier=${pins.cuaDriver.bundleIdentifier}\nTeamIdentifier=${teamIdentifier}\n` };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const run = (binary) => ({
    status: 0,
    stdout: binary.endsWith('agent-browser') ? `agent-browser ${pins.agentBrowser.version}\n` : `cua-driver ${pins.cuaDriver.version}\n`,
  });
  return { appPath: path.join(dist, 'Fixture Dev.app'), codesign, run, noticesSource };
};

test('the packed drivers report the pinned versions, the pinned signer and the notices', (t) => {
  const { pins } = fixtureDrivers(t);
  const { appPath, codesign, run, noticesSource } = packedApp(t, pins);
  assert.deepEqual(verifyPackedDrivers({ appPath, pins, codesign, run, notices: noticesSource }), {
    agentBrowserVersion: pins.agentBrowser.version,
    cuaDriverVersion: pins.cuaDriver.version,
    cuaTeamIdentifier: pins.cuaDriver.teamIdentifier,
  });
});

test('a packed CuaDriver.app with another team identifier fails the check', (t) => {
  const { pins } = fixtureDrivers(t);
  const { appPath, codesign, run, noticesSource } = packedApp(t, pins, { teamIdentifier: 'not set' });
  assert.throws(() => verifyPackedDrivers({ appPath, pins, codesign, run, notices: noticesSource }), /CuaDriver\.app is signed as test\.example\.driver by team not set, not test\.example\.driver by team TEAM000001: it was re-signed and would lose its macOS permission identity/);
});

test('a re-signed packed agent-browser passes only when its unsigned bytes are the pinned ones', (t) => {
  const { pins } = fixtureDrivers(t);
  const { appPath, codesign, run, noticesSource } = packedApp(t, pins);
  const binary = path.join(appPath, 'Contents', 'Resources', 'agent-browser', 'agent-browser');
  fs.writeFileSync(binary, machOArm64('re-signed agent-browser'));
  const resigned = { sha256: pins.agentBrowser.resignedStrippedSha256, bytes: pins.agentBrowser.resignedStrippedBytes };
  assert.equal(verifyPackedDrivers({ appPath, pins, codesign, run, notices: noticesSource, unsigned: () => resigned }).agentBrowserVersion, pins.agentBrowser.version);
  assert.throws(
    () => verifyPackedDrivers({ appPath, pins, codesign, run, notices: noticesSource, unsigned: () => ({ sha256: 'c'.repeat(64), bytes: 40 }) }),
    /the packed agent-browser has sha256 [0-9a-f]{64} \(c{64} without its signature\), not the pinned agent-browser 9\.8\.7/,
  );
});

test('a re-signed packed agent-browser with the pinned unsigned hash but another byte count fails the check', (t) => {
  const { pins } = fixtureDrivers(t);
  const { appPath, codesign, run, noticesSource } = packedApp(t, pins);
  fs.writeFileSync(path.join(appPath, 'Contents', 'Resources', 'agent-browser', 'agent-browser'), machOArm64('re-signed agent-browser'));
  const wrongBytes = () => ({ sha256: pins.agentBrowser.resignedStrippedSha256, bytes: pins.agentBrowser.resignedStrippedBytes + 1 });
  assert.throws(() => verifyPackedDrivers({ appPath, pins, codesign, run, notices: noticesSource, unsigned: wrongBytes }), /not the pinned agent-browser 9\.8\.7/);
});

test('a packed agent-browser that is not executable or fails its signature check fails the check', (t) => {
  const { pins } = fixtureDrivers(t);
  const plain = packedApp(t, pins);
  fs.chmodSync(path.join(plain.appPath, 'Contents', 'Resources', 'agent-browser', 'agent-browser'), 0o644);
  assert.throws(() => verifyPackedDrivers({ ...plain, pins, notices: plain.noticesSource }), /the packed agent-browser is not executable/);
  const unsigned = packedApp(t, pins);
  const failsStrict = (args) => (args[0] === '--verify' && args[1] === '--strict' ? { status: 1, stdout: '', stderr: 'code object is not signed at all' } : unsigned.codesign(args));
  assert.throws(() => verifyPackedDrivers({ ...unsigned, codesign: failsStrict, pins, notices: unsigned.noticesSource }), /the packed agent-browser fails codesign --verify --strict: code object is not signed at all/);
});

test('a packed CuaDriver.app whose binary changed fails the check as re-signed', (t) => {
  const { pins } = fixtureDrivers(t);
  const packed = packedApp(t, pins);
  fs.writeFileSync(path.join(packed.appPath, 'Contents', 'Resources', 'cua-driver', 'CuaDriver.app', 'Contents', 'MacOS', 'cua-driver'), Buffer.from('fixture cua-driver binary, re-signed'));
  assert.throws(() => verifyPackedDrivers({ ...packed, pins, notices: packed.noticesSource }), /the packed CuaDriver\.app binary has sha256 [0-9a-f]{64}, not the pinned [0-9a-f]{64}: it was re-signed and would lose its macOS permission identity/);
});

test('a packed CuaDriver.app with another identifier fails the check', (t) => {
  const { pins } = fixtureDrivers(t);
  const packed = packedApp(t, { ...pins, cuaDriver: { ...pins.cuaDriver, bundleIdentifier: 'test.example.other' } });
  assert.throws(() => verifyPackedDrivers({ ...packed, pins, notices: packed.noticesSource }), /CuaDriver\.app is signed as test\.example\.other by team TEAM000001, not test\.example\.driver by team TEAM000001: it was re-signed/);
});

test('a packed cua-driver link that is missing or points elsewhere fails the check', (t) => {
  const { pins } = fixtureDrivers(t);
  const packed = packedApp(t, pins);
  const link = path.join(packed.appPath, 'Contents', 'Resources', 'cua-driver', 'cua-driver');
  fs.rmSync(link);
  fs.symlinkSync('./CuaDriver.app/Contents/MacOS/other', link);
  assert.throws(() => verifyPackedDrivers({ ...packed, pins, notices: packed.noticesSource }), /cua-driver is not a link to \.\/CuaDriver\.app\/Contents\/MacOS\/cua-driver/);
  fs.rmSync(link);
  assert.throws(() => verifyPackedDrivers({ ...packed, pins, notices: packed.noticesSource }), /cua-driver is not a link to/);
});

test('a packed CuaDriver.app that fails the deep signature check fails the check', (t) => {
  const { pins } = fixtureDrivers(t);
  const packed = packedApp(t, pins);
  const failsDeep = (args) => (args[1] === '--deep' ? { status: 1, stdout: '', stderr: 'nested code is modified or invalid' } : packed.codesign(args));
  assert.throws(() => verifyPackedDrivers({ ...packed, codesign: failsDeep, pins, notices: packed.noticesSource }), /the packed CuaDriver\.app fails codesign --verify --deep --strict: nested code is modified or invalid/);
});

test('a packed driver that reports another version fails the check', (t) => {
  const { pins } = fixtureDrivers(t);
  const packed = packedApp(t, pins);
  const oldCua = (binary, args) => (binary.endsWith('agent-browser') ? packed.run(binary, args) : { status: 0, stdout: 'cua-driver 0.0.1\n' });
  assert.throws(() => verifyPackedDrivers({ ...packed, run: oldCua, pins, notices: packed.noticesSource }), /the packed cua-driver does not report cua-driver 9\.9\.9 \(exit 0\): cua-driver 0\.0\.1/);
  const brokenAgentBrowser = (binary, args) => (binary.endsWith('agent-browser') ? { status: 1, stdout: '' } : packed.run(binary, args));
  assert.throws(() => verifyPackedDrivers({ ...packed, run: brokenAgentBrowser, pins, notices: packed.noticesSource }), /the packed agent-browser does not report agent-browser 9\.8\.7 \(exit 1\)/);
});

test('a packed app without the notices, or with another notices file, fails the check', (t) => {
  const { pins } = fixtureDrivers(t);
  const bare = packedApp(t, pins, { notices: false });
  assert.throws(() => verifyPackedDrivers({ ...bare, pins, notices: bare.noticesSource }), /the packed app has no THIRD_PARTY_NOTICES\.md/);
  const other = packedApp(t, pins);
  fs.writeFileSync(path.join(other.appPath, 'Contents', 'Resources', NOTICES_RESOURCE), 'edited\n');
  assert.throws(() => verifyPackedDrivers({ ...other, pins, notices: other.noticesSource }), /THIRD_PARTY_NOTICES\.md is not brand\/THIRD_PARTY_NOTICES\.md/);
});

test('the notices carry the fetched agent-browser licence unchanged and the pinned cua-driver section', (t) => {
  const pins = readDriverPins();
  const text = fs.readFileSync(path.join(repoRoot, 'brand', 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.equal(sha256(noticeLicenceText(text, 'agent-browser')), pins.agentBrowser.licenceSha256);
  assert.ok(text.includes(pins.agentBrowser.licenceUrl));
  const cua = noticeSection(text, 'cua-driver');
  assert.equal(sha256(cua), pins.cuaDriver.noticeSha256);
  assert.match(cua, /^## cua-driver\n\nBundled from https:\/\/github\.com\/trycua\/cua \(`scripts\/mittr\/drivers\.mjs`\)\.\n\nMIT License\n\nCopyright \(c\) 2025 Cua AI, Inc\.\n/);
  assert.ok(cua.endsWith('SOFTWARE.\n'));
  assert.doesNotThrow(() => checkNotices({ pins }));
  assert.throws(() => checkNotices({ pins: { ...pins, agentBrowser: { ...pins.agentBrowser, licenceSha256: 'd'.repeat(64) } } }), /agent-browser licence text in brand\/THIRD_PARTY_NOTICES\.md has sha256 [0-9a-f]{64}, not the pinned d{64}/);

  const edited = path.join(scratch(t, 'notices-'), 'notices.md');
  fs.writeFileSync(edited, text.replace('Copyright (c) 2025 Cua AI, Inc.', 'Copyright (c) 2025 Someone Else'));
  assert.throws(() => checkNotices({ pins, file: edited }), /the cua-driver section of brand\/THIRD_PARTY_NOTICES\.md has sha256 [0-9a-f]{64}, not the pinned 5c428ced/);
});

test('a build for any architecture but arm64 refuses to pack the drivers', () => {
  assert.equal(assertDriverArchitecture('arm64'), 'arm64');
  assert.throws(() => assertDriverArchitecture('x64'), /pinned for arm64 only; a x64 build would pack an arm64 agent-browser, so it is refused/);
});

const NETWORK_MODULES = ['http', 'https', 'http2', 'net', 'tls', 'dns', 'dgram', 'undici'];
const NETWORK_BINARIES = ['curl', 'wget', 'nc', 'scp', 'rsync'];

const networkUseIn = (source) => [
  ...[...source.matchAll(/\bfetch\b|\bXMLHttpRequest\b|\bWebSocket\b/g)].map((match) => match[0]),
  ...[...source.matchAll(/['"`](?:node:)?([a-z0-9]+)(?:\/[a-z]+)?['"`]/g)].filter((match) => NETWORK_MODULES.includes(match[1])).map((match) => match[0]),
  ...[...source.matchAll(/['"`](?:\/usr\/bin\/)?([a-z]+)['"`]/g)].filter((match) => NETWORK_BINARIES.includes(match[1])).map((match) => match[0]),
  ...[...source.matchAll(/\bimport\(([^)]*)/g)].filter((match) => !match[1].startsWith('pathToFileURL(')).map((match) => match[0]),
];

test('the network scan finds static and dynamic imports, fetch and spawned download tools', () => {
  assert.deepEqual(networkUseIn("import http from 'node:http';"), ["'node:http'"]);
  assert.deepEqual(networkUseIn("const m = await import('node:https');"), ["'node:https'", "import('node:https'"]);
  assert.deepEqual(networkUseIn("import('dns'); require(\"dgram\");"), ["'dns'", '"dgram"', "import('dns'"]);
  assert.deepEqual(networkUseIn('globalThis.fetch'), ['fetch']);
  assert.deepEqual(networkUseIn("spawnSync('curl', ['-L', url]); spawnSync('/usr/bin/wget', [url]);"), ["'curl'", "'/usr/bin/wget'"]);
  assert.deepEqual(networkUseIn("await import(pathToFileURL(file).href); spawnSync('tar', []); spawnSync('codesign', [])"), []);
});

test('the driver module and the build script never reach the network', () => {
  for (const file of ['drivers.mjs', 'build-desktop.mjs']) {
    const source = fs.readFileSync(path.join(repoRoot, 'scripts', 'mittr', file), 'utf8');
    assert.deepEqual(networkUseIn(source), [], file);
  }
});
