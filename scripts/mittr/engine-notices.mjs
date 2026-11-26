#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveBunExecutable } from '../lib/bun-executable.mjs';
import { NOTICES_RESOURCE } from './drivers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronDir = path.join(repoRoot, 'packages', 'electron');
const noticesSource = path.join(repoRoot, 'brand', NOTICES_RESOURCE);

export const ENGINE_NOTICES_HEADING = 'OpenCode server';
const ENGINE_NOTICES_BEFORE = 'cua-driver';
const FENCE = '````';
const ENGINE_CACHE = path.join('.cache', 'opencode-server');
const LICENCE_FILE = /^(licen[cs]e|copying|notice)/i;

const RECORD_METAFILE = `
const fs = await import('node:fs');
const build = Bun.build;
Bun.build = async (options) => {
  const result = await build({ ...options, metafile: true });
  fs.writeFileSync(process.env.MITTR_ENGINE_METAFILE, JSON.stringify(result.metafile));
  return result;
};
`;

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const byName = (left, right) => (left.name === right.name ? compare(left.version, right.version) : compare(left.name, right.name));
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const files = (dir) => fs.readdirSync(dir, { withFileTypes: true, recursive: true })
  .filter((entry) => entry.isFile())
  .map((entry) => path.join(entry.parentPath, entry.name));

export const engineCachePresent = (dir = electronDir) => fs.existsSync(path.join(dir, ENGINE_CACHE));

const packageRoot = (input) => {
  const inNodeModules = input.lastIndexOf('node_modules/');
  if (inNodeModules !== -1) {
    const start = inNodeModules + 'node_modules/'.length;
    const [first, second] = input.slice(start).split('/');
    return input.slice(0, start) + (first.startsWith('@') ? `${first}/${second}` : first);
  }
  return /^(.*\/opencode-server\/[^/]+\/package)\//.exec(input)?.[1] ?? null;
};

export const bundledPackageDirs = ({ metafile, rootDir }) => {
  const dirs = new Set();
  for (const output of Object.values(metafile.outputs)) {
    for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
      const root = packageRoot(input);
      if (root && bytesInOutput > 0) dirs.add(path.resolve(rootDir, root));
    }
  }
  return [...dirs];
};

export const nativePackageDirs = ({ assetsDir, cacheDir }) => fs.globSync('@*/*', { cwd: assetsDir }).map((name) => {
  const packed = files(path.join(assetsDir, name));
  const prefix = `${name.split(path.sep).join('+')}@`;
  const found = fs.readdirSync(cacheDir)
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => path.join(cacheDir, entry, 'package'))
    .find((dir) => packed.every((file) => {
      const source = path.join(dir, path.relative(path.join(assetsDir, name), file));
      return fs.existsSync(source) && fs.readFileSync(source).equals(fs.readFileSync(file));
    }));
  if (!found) throw new Error(`no package in ${cacheDir} has the packed files of ${name}`);
  return found;
});

const repositoryOf = (manifest) => {
  const url = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  if (!url) return manifest.homepage ?? '';
  return url.replace(/^git\+/, '').replace(/^(git|ssh):\/\/(git@)?/, 'https://').replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '').replace(/^github:/, 'https://github.com/').replace(/^([\w.-]+\/[\w.-]+)$/, 'https://github.com/$1');
};

const personOf = (person) => (typeof person === 'string' ? person : [person?.name, person?.email && `<${person.email}>`].filter(Boolean).join(' '));

const readText = (file) => fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n').replace(/\n+$/, '');

const readmeLicence = (dir) => {
  const readme = path.join(dir, 'README.md');
  const found = fs.existsSync(readme) ? /^(?:#+ *licen[cs]e\b.*|licen[cs]e *\n-+)\n+([\s\S]*)$/im.exec(readText(readme))?.[1].split(/^#+ /m)[0].trimEnd() : undefined;
  return found && /Permission (?:is hereby granted|to use)/.test(found) ? [found] : [];
};

const texts = (dir) => {
  const found = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENCE_FILE.test(entry.name))
    .map((entry) => readText(path.join(dir, entry.name)))
    .filter(Boolean);
  return found.length > 0 ? found : readmeLicence(dir);
};

export const readPackage = (dir) => {
  const manifest = readJson(path.join(dir, 'package.json'));
  return {
    name: manifest.name,
    version: manifest.version,
    licence: typeof manifest.license === 'string' ? manifest.license : manifest.license?.type ?? '',
    repository: repositoryOf(manifest),
    author: personOf(manifest.author ?? ''),
    parts: Object.keys(manifest.optionalDependencies ?? {}),
    texts: texts(dir),
  };
};

const isOpenLicence = ({ licence }) => licence !== '' && !/^(see licen[cs]e|unlicensed)/i.test(licence);

export const splitPackages = (packages) => {
  const unique = [...new Map(packages.map((entry) => [`${entry.name}@${entry.version}`, entry])).values()].sort(byName);
  return { listed: unique.filter(isOpenLicence), heldBack: unique.filter((entry) => !isOpenLicence(entry)) };
};

const withSharedTexts = (packages) => packages.map((entry) => {
  if (entry.texts.length > 0) return entry;
  const sibling = packages.find((other) => other.texts.length > 0 && other.licence === entry.licence
    && (other.parts.includes(entry.name) || (other.repository === entry.repository && entry.repository !== '')));
  return sibling ? { ...entry, texts: sibling.texts } : entry;
});

const label = ({ name, version, licence }) => `\`${name}\` ${version} (${licence})`;

export const renderEngineNotices = (packages) => {
  const entries = withSharedTexts(packages);
  const groups = new Map();
  for (const entry of entries) {
    for (const text of entry.texts) groups.set(text, [...(groups.get(text) ?? []), entry]);
  }
  const bare = entries.filter((entry) => entry.texts.length === 0);
  return [
    `## ${ENGINE_NOTICES_HEADING}`,
    '',
    'The app carries these packages in `Contents/Resources/opencode-server`: bundled into `chunks`, or as native files under `assets`. `node scripts/mittr/engine-notices.mjs --write` writes this section from the packages the bundle is made of.',
    '',
    ...entries.map((entry) => `- ${label(entry)}`),
    ...[...groups].flatMap(([text, users]) => ['', `### Licence of ${users.map(({ name, version }) => `${name} ${version}`).join(', ')}`, '', FENCE, text, FENCE]),
    ...(bare.length === 0 ? [] : [
      '',
      '### Packages that ship no licence file',
      '',
      ...bare.map((entry) => `- ${label(entry)}${entry.author ? `, by ${entry.author}` : ''}; see \`${entry.licence}\` terms at its source${entry.repository ? `, ${entry.repository}` : ''}.`),
    ]),
    '',
  ].join('\n');
};

const sectionRange = (notices) => {
  const before = notices.indexOf(`\n## ${ENGINE_NOTICES_BEFORE}\n`);
  if (before === -1) throw new Error(`${NOTICES_RESOURCE} has no ${ENGINE_NOTICES_BEFORE} section`);
  const heading = notices.indexOf(`\n## ${ENGINE_NOTICES_HEADING}\n`);
  return heading === -1 ? [before + 1, before + 1] : [heading + 1, before + 1];
};

export const writeEngineNotices = (notices, section) => {
  const [start, end] = sectionRange(notices);
  return `${notices.slice(0, start)}${section}\n${notices.slice(end)}`;
};

export const readEngineNotices = (notices) => notices.slice(...sectionRange(notices));

const link = (target, at) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : undefined);

export const collectEnginePackages = ({ dir = electronDir, bun = resolveBunExecutable() } = {}) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-engine-notices-'));
  try {
    fs.mkdirSync(path.join(work, 'scripts'));
    for (const script of ['prepare-opencode-server.mjs', 'target-architecture.mjs']) {
      fs.copyFileSync(path.join(dir, 'scripts', script), path.join(work, 'scripts', script));
    }
    fs.copyFileSync(path.join(dir, 'package.json'), path.join(work, 'package.json'));
    for (const linked of ['node_modules', 'opencode-server', '.cache']) link(path.join(dir, linked), path.join(work, linked));
    const preload = path.join(work, 'record-metafile.mjs');
    fs.writeFileSync(preload, RECORD_METAFILE);
    const metafile = path.join(work, 'metafile.json');
    const result = spawnSync(bun, ['--preload', preload, path.join(work, 'scripts', 'prepare-opencode-server.mjs')], {
      cwd: work, env: { ...process.env, MITTR_ENGINE_METAFILE: metafile }, encoding: 'utf8',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`bundling the OpenCode server for its notices failed (exit ${result.status})\n${result.stderr}`);
    const dirs = [
      ...bundledPackageDirs({ metafile: readJson(metafile), rootDir: fs.realpathSync(work) }),
      ...nativePackageDirs({ assetsDir: path.join(work, 'resources', 'opencode-server', 'assets'), cacheDir: path.join(dir, ENGINE_CACHE) }),
    ];
    return splitPackages(dirs.map(readPackage));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
};

export const checkEngineNotices = ({ file = noticesSource, collect = collectEnginePackages } = {}) => {
  const { listed, heldBack } = collect();
  const section = `${renderEngineNotices(listed)}\n`;
  if (readEngineNotices(fs.readFileSync(file, 'utf8')) !== section) {
    throw new Error(`the ${ENGINE_NOTICES_HEADING} section of brand/${NOTICES_RESOURCE} does not match the packages the engine bundles; run node scripts/mittr/engine-notices.mjs --write`);
  }
  return { listed, heldBack };
};

const main = () => {
  const { listed, heldBack } = process.argv.includes('--write') ? collectEnginePackages() : checkEngineNotices();
  if (process.argv.includes('--write')) {
    fs.writeFileSync(noticesSource, writeEngineNotices(fs.readFileSync(noticesSource, 'utf8'), renderEngineNotices(listed)));
  }
  console.log(`[mittr] ${listed.length} engine packages in brand/${NOTICES_RESOURCE}`);
  for (const entry of heldBack) console.log(`[mittr] left out, not under an open licence and not packed: ${entry.name} ${entry.version} (${entry.licence})`);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    console.error(`[mittr] ${error.message}`);
    process.exit(1);
  }
}
