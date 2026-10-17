import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';

import {
  RIPGREP_ARCHIVE_ENV,
  RIPGREP_LICENCE_FILES,
  defaultRipgrepArchive,
  readRipgrepPin,
  readTarEntries,
  stageRipgrep,
  verifyPackedRipgrep,
} from './ripgrep.mjs';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const octal = (value, width) => `${value.toString(8).padStart(width - 1, '0')}\0`;

const tarHeader = ({ name, size = 0, type = '0', linkname = '' }) => {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write(octal(type === '5' ? 0o755 : 0o644, 8), 100);
  header.write(octal(0, 8), 108);
  header.write(octal(0, 8), 116);
  header.write(octal(size, 12), 124);
  header.write(octal(0, 12), 136);
  header.write(' '.repeat(8), 148);
  header.write(type, 156);
  header.write(linkname, 157, 100);
  header.write('ustar\0', 257);
  header.write('00', 263);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
};

const tarGz = (entries) => {
  const blocks = [];
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    blocks.push(tarHeader({ ...entry, size: data.length }));
    if (data.length > 0) blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
};

const machOArm64 = () => {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.write('fixture rg', 32);
  return bytes;
};

const TOP = 'ripgrep-9.9.9-aarch64-apple-darwin';

const releaseEntries = (binary = machOArm64()) => [
  { name: `${TOP}/`, type: '5' },
  { name: `${TOP}/rg`, data: binary },
  ...RIPGREP_LICENCE_FILES.map((licence) => ({ name: `${TOP}/${licence}`, data: Buffer.from(`${licence} text\n`) })),
  { name: `${TOP}/doc/`, type: '5' },
  { name: `${TOP}/doc/rg.1`, data: Buffer.from('manual\n') },
];

const fixture = (t, entries = releaseEntries(), binary = machOArm64()) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-rg-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bytes = tarGz(entries);
  const archive = path.join(dir, 'ripgrep-9.9.9-aarch64-apple-darwin.tar.gz');
  fs.writeFileSync(archive, bytes);
  const pin = {
    version: '9.9.9',
    target: 'aarch64-apple-darwin',
    asset: 'ripgrep-9.9.9-aarch64-apple-darwin.tar.gz',
    url: 'https://example.invalid/ripgrep-9.9.9-aarch64-apple-darwin.tar.gz',
    archiveSha256: sha256(bytes),
    binarySha256: sha256(binary),
    resignedStrippedSha256: 'f'.repeat(64),
  };
  return { dir, archive, pin, outDir: path.join(dir, 'out', 'ripgrep') };
};

test('the pin names ripgrep 15.1.0 for Apple silicon, the release URL and three hashes', () => {
  const pin = readRipgrepPin();
  assert.equal(pin.version, '15.1.0');
  assert.equal(pin.asset, 'ripgrep-15.1.0-aarch64-apple-darwin.tar.gz');
  assert.equal(pin.url, `https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/${pin.asset}`);
  for (const key of ['archiveSha256', 'binarySha256', 'resignedStrippedSha256']) assert.match(pin[key], /^[0-9a-f]{64}$/, key);
});

test('the archive is read from the electron build cache unless the env names another path', () => {
  const pin = readRipgrepPin();
  assert.match(defaultRipgrepArchive(pin, {}), /packages\/electron\/\.cache\/ripgrep\/ripgrep-15\.1\.0-aarch64-apple-darwin\.tar\.gz$/);
  assert.equal(defaultRipgrepArchive(pin, { [RIPGREP_ARCHIVE_ENV]: '/srv/cache/rg.tar.gz' }), '/srv/cache/rg.tar.gz');
});

test('a missing archive stops the build and says where to put it and what hash it must have', (t) => {
  const { dir, pin, outDir } = fixture(t);
  const missing = path.join(dir, 'nowhere.tar.gz');
  assert.throws(() => stageRipgrep({ archive: missing, pin, outDir, checkVersion: false }), (error) => {
    for (const part of [missing, pin.asset, pin.url, RIPGREP_ARCHIVE_ENV, pin.archiveSha256, 'never downloads']) {
      assert.ok(error.message.includes(part), `${part} is not in: ${error.message}`);
    }
    return true;
  });
  assert.equal(fs.existsSync(outDir), false);
});

test('an archive whose hash is not the pinned one stops the build before anything is read from it', (t) => {
  const { archive, pin, outDir } = fixture(t);
  assert.throws(() => stageRipgrep({ archive, pin: { ...pin, archiveSha256: '0'.repeat(64) }, outDir, checkVersion: false }), /has sha256 [0-9a-f]{64}, not the pinned 0{64}/);
  assert.equal(fs.existsSync(outDir), false);
});

test('an entry that climbs out, starts at the root, or is a link is refused', () => {
  const plain = releaseEntries();
  const cases = [
    [{ name: `${TOP}/../../evil`, data: Buffer.from('x') }, /unsafe entry path/],
    [{ name: '/etc/evil', data: Buffer.from('x') }, /unsafe entry path/],
    [{ name: `${TOP}/rg-link`, type: '2', linkname: '/bin/sh' }, /is not a plain file or folder \(type "2"\)/],
    [{ name: `${TOP}/hard`, type: '1', linkname: `${TOP}/rg` }, /is not a plain file or folder \(type "1"\)/],
  ];
  for (const [entry, refusal] of cases) {
    assert.throws(() => readTarEntries(tarGz([...plain, entry])), refusal, entry.name);
  }
  assert.equal(readTarEntries(tarGz(plain)).size, 5);
});

test('a link entry stops the whole staging step', (t) => {
  const { archive, pin, outDir } = fixture(t, [...releaseEntries(), { name: `${TOP}/rg-link`, type: '2', linkname: '/bin/sh' }]);
  assert.throws(() => stageRipgrep({ archive, pin, outDir, checkVersion: false }), /not a plain file or folder/);
  assert.equal(fs.existsSync(outDir), false);
});

test('only rg and its licences are staged, rg executable', (t) => {
  const { archive, pin, outDir } = fixture(t);
  const staged = stageRipgrep({ archive, pin, outDir, checkVersion: false });
  assert.equal(staged.binary, path.join(outDir, 'rg'));
  assert.deepEqual(fs.readdirSync(outDir).sort(), ['COPYING', 'LICENSE-MIT', 'UNLICENSE', 'rg']);
  assert.equal(fs.statSync(staged.binary).mode & 0o777, 0o755);
  assert.equal(sha256(fs.readFileSync(staged.binary)), pin.binarySha256);
});

test('an rg that is not a Mach-O arm64 executable, or not the pinned bytes, is refused', (t) => {
  const script = Buffer.from('#!/bin/sh\necho hi\n');
  const notMachO = fixture(t, releaseEntries(script), script);
  assert.throws(() => stageRipgrep({ ...notMachO, checkVersion: false }), /not a Mach-O arm64 executable/);

  const intel = machOArm64();
  intel.writeUInt32LE(0x01000007, 4);
  const x64 = fixture(t, releaseEntries(intel), intel);
  assert.throws(() => stageRipgrep({ ...x64, checkVersion: false }), /not a Mach-O arm64 executable/);

  const other = fixture(t);
  assert.throws(() => stageRipgrep({ ...other, pin: { ...other.pin, binarySha256: '1'.repeat(64) }, checkVersion: false }), /not the pinned 1{64}/);
});

const fakeApp = (t, { binary = Buffer.from('rg bytes'), mode = 0o755, licences = RIPGREP_LICENCE_FILES } = {}) => {
  const appPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-rg-app-')), 'Fixture.app');
  t.after(() => fs.rmSync(path.dirname(appPath), { recursive: true, force: true }));
  const dir = path.join(appPath, 'Contents', 'Resources', 'ripgrep');
  fs.mkdirSync(dir, { recursive: true });
  if (binary) fs.writeFileSync(path.join(dir, 'rg'), binary, { mode });
  for (const licence of licences) fs.writeFileSync(path.join(dir, licence), 'text');
  return { appPath, binary };
};

test('the packed app must carry an executable rg with the pinned bytes and its licences', (t) => {
  const pinFor = (bytes) => ({ version: '9.9.9', binarySha256: sha256(bytes), resignedStrippedSha256: 'a'.repeat(64) });
  const never = () => assert.fail('an exact match needs no signature check');

  const exact = fakeApp(t);
  assert.ok(verifyPackedRipgrep({ appPath: exact.appPath, pin: pinFor(exact.binary), unsigned: never }).endsWith('ripgrep/rg'));

  assert.throws(() => verifyPackedRipgrep({ appPath: fakeApp(t, { binary: null }).appPath, pin: pinFor(Buffer.from('x')) }), /has no bundled rg/);
  const plain = fakeApp(t, { mode: 0o644 });
  assert.throws(() => verifyPackedRipgrep({ appPath: plain.appPath, pin: pinFor(plain.binary) }), /is not executable/);
  const unlicensed = fakeApp(t, { licences: ['COPYING'] });
  assert.throws(() => verifyPackedRipgrep({ appPath: unlicensed.appPath, pin: pinFor(unlicensed.binary) }), /no ripgrep LICENSE-MIT beside rg/);

  const resigned = fakeApp(t, { binary: Buffer.from('re-signed rg bytes') });
  const pin = pinFor(Buffer.from('rg bytes'));
  assert.ok(verifyPackedRipgrep({ appPath: resigned.appPath, pin, unsigned: () => 'a'.repeat(64) }));
  assert.throws(() => verifyPackedRipgrep({ appPath: resigned.appPath, pin, unsigned: () => 'b'.repeat(64) }), /not the pinned ripgrep 9\.9\.9/);
});

test('the pinned release archive in the build cache stages rg 15.1.0, and a re-signed copy still passes the packed check', (t) => {
  const pin = readRipgrepPin();
  const archive = defaultRipgrepArchive(pin, {});
  if (!fs.existsSync(archive) || process.platform !== 'darwin' || process.arch !== 'arm64') {
    t.diagnostic(`no pinned archive at ${archive} on this machine, so only the fixtures are checked`);
    return;
  }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-rg-real-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const staged = stageRipgrep({ archive, pin, outDir: path.join(out, 'stage', 'ripgrep'), checkVersion: true });
  assert.equal(sha256(fs.readFileSync(staged.binary)), pin.binarySha256);

  const appPath = path.join(out, 'Fixture.app');
  const packedDir = path.join(appPath, 'Contents', 'Resources', 'ripgrep');
  fs.cpSync(path.dirname(staged.binary), packedDir, { recursive: true });
  assert.ok(verifyPackedRipgrep({ appPath, pin }));

  const sign = spawnSync('codesign', ['--force', '--sign', '-', '--options', 'runtime', path.join(packedDir, 'rg')], { encoding: 'utf8' });
  assert.equal(sign.status, 0, sign.stderr);
  assert.notEqual(sha256(fs.readFileSync(path.join(packedDir, 'rg'))), pin.binarySha256);
  assert.ok(verifyPackedRipgrep({ appPath, pin }));

  fs.appendFileSync(path.join(packedDir, 'rg'), Buffer.from('tampered'));
  assert.throws(() => verifyPackedRipgrep({ appPath, pin }), /not the pinned ripgrep 15\.1\.0|codesign could not read/);
});
