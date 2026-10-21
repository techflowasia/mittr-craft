import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMachOArm64 } from './ripgrep.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cacheDir = path.join(repoRoot, 'packages', 'electron', '.cache');

const DRIVER_PIN_FILE = path.join(repoRoot, 'scripts', 'mittr', 'drivers.json');
export const AGENT_BROWSER_BINARY_ENV = 'MITTRCRAFT_AGENT_BROWSER_BINARY';
export const CUA_DRIVER_ARCHIVE_ENV = 'MITTRCRAFT_CUA_DRIVER_ARCHIVE';
export const AGENT_BROWSER_RESOURCE_DIR = 'agent-browser';
export const CUA_DRIVER_RESOURCE_DIR = 'cua-driver';
export const NOTICES_RESOURCE = 'THIRD_PARTY_NOTICES.md';
const NOTICES_SOURCE = path.join(repoRoot, 'brand', NOTICES_RESOURCE);

const CUA_APP = 'CuaDriver.app';
const CUA_BINARY = path.join('Contents', 'MacOS', 'cua-driver');
const CUA_LINK_TARGET = `./${CUA_APP}/Contents/MacOS/cua-driver`;

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

export const readDriverPins = (file = DRIVER_PIN_FILE) => JSON.parse(fs.readFileSync(file, 'utf8'));

const fromEnv = (env, name) => {
  const value = String(env[name] ?? '').trim();
  return value ? path.resolve(value) : null;
};

export const driverSources = (pins, env = process.env) => ({
  agentBrowserBinary: fromEnv(env, AGENT_BROWSER_BINARY_ENV)
    ?? path.join(cacheDir, 'agent-browser', pins.agentBrowser.version, pins.agentBrowser.asset),
  cuaArchive: fromEnv(env, CUA_DRIVER_ARCHIVE_ENV)
    ?? path.join(cacheDir, 'cua-driver', pins.cuaDriver.version, pins.cuaDriver.asset),
});

const pinMessage = ({ asset, url }, expected) => `${asset} is missing or does not match scripts/mittr/drivers.json (expected sha256 ${expected}). Downloading it from ${url} needs the owner's yes.`;

const readPinnedFile = ({ file, pin, expectedSha256, expectedBytes }) => {
  if (!fs.existsSync(file)) throw new Error(pinMessage(pin, expectedSha256));
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== expectedSha256 || bytes.length !== expectedBytes) throw new Error(pinMessage(pin, expectedSha256));
  return bytes;
};

const readAgentBrowser = (pins, file) => {
  const pin = pins.agentBrowser;
  const bytes = readPinnedFile({ file, pin, expectedSha256: pin.sha256, expectedBytes: pin.bytes });
  if (!isMachOArm64(bytes)) throw new Error(`${pin.asset} is not a Mach-O arm64 executable`);
  return bytes;
};

const readCuaArchive = (pins, file) => {
  const pin = pins.cuaDriver;
  return readPinnedFile({ file, pin, expectedSha256: pin.archiveSha256, expectedBytes: pin.archiveBytes });
};

export const assertDriverArchitecture = (architecture) => {
  if (architecture !== 'arm64') {
    throw new Error(`the drivers in scripts/mittr/drivers.json are pinned for arm64 only; a ${architecture} build would pack an arm64 agent-browser, so it is refused`);
  }
  return architecture;
};

export const checkDriverSources = ({ pins = readDriverPins(), env = process.env } = {}) => {
  const sources = driverSources(pins, env);
  readAgentBrowser(pins, sources.agentBrowserBinary);
  readCuaArchive(pins, sources.cuaArchive);
  return { pins, ...sources };
};

export const noticeSection = (notices, name) => {
  const heading = `\n## ${name}\n`;
  const start = notices.indexOf(heading);
  if (start === -1) throw new Error(`${NOTICES_RESOURCE} has no ${name} section`);
  const next = notices.indexOf('\n## ', start + heading.length);
  return notices.slice(start + 1, next === -1 ? notices.length : next + 1);
};

export const noticeLicenceText = (notices, name) => {
  const heading = `\n## ${name}\n\n`;
  const start = notices.indexOf(heading);
  if (start === -1) throw new Error(`${NOTICES_RESOURCE} has no ${name} section`);
  const body = notices.indexOf('\n\n', start + heading.length) + 2;
  const next = notices.indexOf('\n## ', body);
  return notices.slice(body, next === -1 ? notices.length : next);
};

export const checkNotices = ({ pins, file = NOTICES_SOURCE }) => {
  const text = fs.readFileSync(file, 'utf8');
  const found = sha256(noticeLicenceText(text, 'agent-browser'));
  if (found !== pins.agentBrowser.licenceSha256) {
    throw new Error(`the agent-browser licence text in brand/${NOTICES_RESOURCE} has sha256 ${found}, not the pinned ${pins.agentBrowser.licenceSha256}`);
  }
  const cuaSection = sha256(noticeSection(text, 'cua-driver'));
  if (cuaSection !== pins.cuaDriver.noticeSha256) {
    throw new Error(`the cua-driver section of brand/${NOTICES_RESOURCE} has sha256 ${cuaSection}, not the pinned ${pins.cuaDriver.noticeSha256}`);
  }
  return file;
};

const runCodesign = (args) => spawnSync('codesign', args, { encoding: 'utf8' });

const extract = (archive, into) => {
  const result = spawnSync('tar', ['-xzf', archive, '-C', into], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`tar could not extract ${archive}: ${String(result.stderr).trim()}`);
};

export const stageDrivers = ({ pins, agentBrowserBinary, cuaArchive, outDir, codesign = runCodesign }) => {
  const agentBrowserBytes = readAgentBrowser(pins, agentBrowserBinary);
  readCuaArchive(pins, cuaArchive);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-build-cua-'));
  const agentBrowserDir = path.join(outDir, AGENT_BROWSER_RESOURCE_DIR);
  const cuaDir = path.join(outDir, CUA_DRIVER_RESOURCE_DIR);
  try {
    extract(cuaArchive, work);
    const top = pins.cuaDriver.asset.replace(/\.tar\.gz$/, '');
    const extractedApp = path.join(work, top, CUA_APP);
    if (!fs.existsSync(extractedApp)) throw new Error(`${pins.cuaDriver.asset} has no ${top}/${CUA_APP}`);
    const found = sha256(fs.readFileSync(path.join(extractedApp, CUA_BINARY)));
    if (found !== pins.cuaDriver.binarySha256) {
      throw new Error(`${CUA_APP}/Contents/MacOS/cua-driver has sha256 ${found}, not the pinned ${pins.cuaDriver.binarySha256}`);
    }

    fs.rmSync(agentBrowserDir, { recursive: true, force: true });
    fs.rmSync(cuaDir, { recursive: true, force: true });
    fs.mkdirSync(agentBrowserDir, { recursive: true });
    const agentBrowser = path.join(agentBrowserDir, 'agent-browser');
    fs.writeFileSync(agentBrowser, agentBrowserBytes, { mode: 0o755 });
    fs.chmodSync(agentBrowser, 0o755);

    fs.mkdirSync(cuaDir, { recursive: true });
    const cuaApp = path.join(cuaDir, CUA_APP);
    fs.cpSync(extractedApp, cuaApp, { recursive: true, verbatimSymlinks: true });
    const cuaDriver = path.join(cuaDir, 'cua-driver');
    fs.symlinkSync(CUA_LINK_TARGET, cuaDriver);

    const verified = codesign(['--verify', '--deep', '--strict', cuaApp]);
    if (verified.status !== 0) {
      fs.rmSync(cuaDir, { recursive: true, force: true });
      throw new Error(`the staged ${CUA_APP} fails codesign --verify --deep --strict: ${String(verified.stderr).trim()}`);
    }
    return { agentBrowser, cuaDriver, cuaApp };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
};

const runIsolated = (binary, args) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-build-driver-home-'));
  try {
    return spawnSync(binary, args, {
      cwd: home,
      env: { HOME: home, CFFIXED_USER_HOME: home, TMPDIR: home, PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
      timeout: 15_000,
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
};

const strippedOf = (binary) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-build-driver-sig-'));
  try {
    const copy = path.join(work, path.basename(binary));
    fs.copyFileSync(binary, copy);
    const result = spawnSync('codesign', ['--remove-signature', copy], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`codesign could not read ${binary}: ${String(result.stderr).trim()}`);
    const bytes = fs.readFileSync(copy);
    return { sha256: sha256(bytes), bytes: bytes.length };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
};

const reportedVersion = ({ run, binary, name, version }) => {
  const result = run(binary, ['--version']);
  const firstLine = String(result.stdout ?? '').split('\n')[0].trim();
  if (result.status !== 0 || firstLine !== `${name} ${version}`) {
    throw new Error(`the packed ${name} does not report ${name} ${version} (exit ${result.status ?? result.signal}): ${firstLine}`);
  }
  return version;
};

const checkPackedAgentBrowser = ({ binary, pin, codesign, unsigned }) => {
  if (!fs.existsSync(binary)) throw new Error(`the packed app has no bundled agent-browser: ${binary}`);
  if ((fs.statSync(binary).mode & 0o111) === 0) throw new Error(`the packed agent-browser is not executable: ${binary}`);
  const strict = codesign(['--verify', '--strict', binary]);
  if (strict.status !== 0) throw new Error(`the packed agent-browser fails codesign --verify --strict: ${String(strict.stderr).trim()}`);
  const bytes = fs.readFileSync(binary);
  const found = sha256(bytes);
  if (found === pin.sha256 && bytes.length === pin.bytes) return;
  const stripped = unsigned(binary);
  if (stripped.sha256 !== pin.resignedStrippedSha256 || stripped.bytes !== pin.resignedStrippedBytes) {
    throw new Error(`the packed agent-browser has sha256 ${found} (${stripped.sha256} without its signature), not the pinned agent-browser ${pin.version}`);
  }
};

const checkPackedCuaApp = ({ cuaDir, pin, codesign }) => {
  const cuaApp = path.join(cuaDir, CUA_APP);
  const link = path.join(cuaDir, 'cua-driver');
  if (!fs.existsSync(cuaApp)) throw new Error(`the packed app has no bundled ${CUA_APP}: ${cuaApp}`);
  if (!fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() || fs.readlinkSync(link) !== CUA_LINK_TARGET) {
    throw new Error(`the packed ${link} is not a link to ${CUA_LINK_TARGET}`);
  }
  const found = sha256(fs.readFileSync(path.join(cuaApp, CUA_BINARY)));
  if (found !== pin.binarySha256) {
    throw new Error(`the packed ${CUA_APP} binary has sha256 ${found}, not the pinned ${pin.binarySha256}: it was re-signed and would lose its macOS permission identity`);
  }
  const details = codesign(['-dv', cuaApp]);
  const text = `${details.stdout ?? ''}\n${details.stderr ?? ''}`;
  const identifier = text.match(/^Identifier=(.+)$/m)?.[1]?.trim() ?? 'none';
  const team = text.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() ?? 'none';
  if (identifier !== pin.bundleIdentifier || team !== pin.teamIdentifier) {
    throw new Error(`the packed ${CUA_APP} is signed as ${identifier} by team ${team}, not ${pin.bundleIdentifier} by team ${pin.teamIdentifier}: it was re-signed and would lose its macOS permission identity`);
  }
  const deep = codesign(['--verify', '--deep', '--strict', cuaApp]);
  if (deep.status !== 0) throw new Error(`the packed ${CUA_APP} fails codesign --verify --deep --strict: ${String(deep.stderr).trim()}`);
  return { link, team };
};

export const verifyPackedDrivers = ({ appPath, pins, run = runIsolated, codesign = runCodesign, unsigned = strippedOf, notices = NOTICES_SOURCE }) => {
  const resources = path.join(appPath, 'Contents', 'Resources');
  const packedNotices = path.join(resources, NOTICES_RESOURCE);
  if (!fs.existsSync(packedNotices)) throw new Error(`the packed app has no ${NOTICES_RESOURCE}: ${packedNotices}`);
  if (sha256(fs.readFileSync(packedNotices)) !== sha256(fs.readFileSync(notices))) {
    throw new Error(`the packed ${NOTICES_RESOURCE} is not brand/${NOTICES_RESOURCE}`);
  }

  const agentBrowser = path.join(resources, AGENT_BROWSER_RESOURCE_DIR, 'agent-browser');
  checkPackedAgentBrowser({ binary: agentBrowser, pin: pins.agentBrowser, codesign, unsigned });
  const { link, team } = checkPackedCuaApp({ cuaDir: path.join(resources, CUA_DRIVER_RESOURCE_DIR), pin: pins.cuaDriver, codesign });

  return {
    agentBrowserVersion: reportedVersion({ run, binary: agentBrowser, name: 'agent-browser', version: pins.agentBrowser.version }),
    cuaDriverVersion: reportedVersion({ run, binary: link, name: 'cua-driver', version: pins.cuaDriver.version }),
    cuaTeamIdentifier: team,
  };
};
