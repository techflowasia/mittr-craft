import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadAsar } from './brand-leak-scan.mjs';

export const BUILD_ROOT_PLACEHOLDER = '/mittrcraft';

const BINARY_PROBE_BYTES = 8192;

const isText = (bytes) => !bytes.subarray(0, BINARY_PROBE_BYTES).includes(0);

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const folderPattern = (folder) => {
  const spellings = [...new Set([folder, folder.replaceAll('\\', '/'), JSON.stringify(folder).slice(1, -1)])];
  return new RegExp(`(?:${spellings.map(escapeRegExp).join('|')})(?![A-Za-z0-9._-])`, 'g');
};

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return walk(full);
  return entry.isFile() ? [full] : [];
});

const relativeTo = (root, file) => path.relative(root, file).split(path.sep).join('/');

export const stripBuildPaths = ({ rootDir, dirs, buildRoot }) => {
  const pattern = folderPattern(buildRoot);
  return dirs
    .map((dir) => path.join(rootDir, dir))
    .filter((dir) => fs.existsSync(dir))
    .flatMap(walk)
    .sort()
    .flatMap((file) => {
      const bytes = fs.readFileSync(file);
      if (!isText(bytes)) return [];
      const text = bytes.toString('utf8');
      const count = text.match(pattern)?.length ?? 0;
      if (count === 0) return [];
      fs.writeFileSync(file, text.replace(pattern, () => BUILD_ROOT_PLACEHOLDER));
      return [{ file: relativeTo(rootDir, file), count }];
    });
};

export const findBuildPaths = (text, { buildRoot, homeDir }) => [
  [buildRoot, 'the repository folder'],
  [homeDir, 'the home folder'],
].filter(([folder]) => folderPattern(folder).test(text)).map(([, label]) => label);

const archivedFiles = (archive, asar) => asar.listPackage(archive, { isPack: false })
  .map((entry) => entry.replace(/^[/\\]+/, '').split(path.sep).join('/'))
  .filter((file) => {
    const stat = asar.statFile(archive, file);
    return !stat.files && !stat.unpacked && !stat.link;
  });

export const verifyNoBuildPaths = ({ appPath, buildRoot, homeDir = os.homedir(), asar = loadAsar() }) => {
  const contents = path.join(appPath, 'Contents');
  const archive = path.join(contents, 'Resources', 'app.asar');
  const leaks = [];
  let checked = 0;
  const check = (label, bytes) => {
    if (!isText(bytes)) return;
    checked += 1;
    const found = findBuildPaths(bytes.toString('utf8'), { buildRoot, homeDir });
    if (found.length > 0) leaks.push(`  ${label}: ${found.join(' and ')}`);
  };
  for (const file of walk(contents)) {
    if (file !== archive) check(relativeTo(appPath, file), fs.readFileSync(file));
  }
  for (const file of archivedFiles(archive, asar)) check(`app.asar/${file}`, asar.extractFile(archive, file));
  if (leaks.length > 0) throw new Error(`${leaks.length} packed files name a folder of the build machine\n${leaks.join('\n')}`);
  return checked;
};
