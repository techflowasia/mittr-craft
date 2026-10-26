import fs from 'node:fs';
import path from 'node:path';

import { jsonBody } from './json-body.js';
import { writePrivateAtomic } from './private-file.js';
import { isLocalRequest } from './tools/control-routes.js';
import { MittrToolError } from './tools/registry.js';
import { isPlainObject } from './values.js';

export const PROJECT_FOLDER_ROUTE = '/api/mittr/project-folder';
export const SOURCE_DIR = '.mittr';
export const TARGET_DIR = '.opencode';
export const COPIED_KINDS = Object.freeze(['agent', 'agents', 'command', 'commands', 'skill', 'skills']);
export const ONLY_ON_THIS_MAC = 'Project folders can be copied only on this Mac';

const NOTICES_FILE = 'mittr-project-folders.json';
const MAX_FILES = 2000;
const BODY_LIMIT = 8 * 1024;
const TOO_MANY = `${SOURCE_DIR} holds more than ${MAX_FILES} files; copy them by hand`;
const TARGET_NOT_A_FOLDER = `${TARGET_DIR} in this project is not a folder MittrCraft can write into`;
const NOT_A_PROJECT = 'This folder is not one of your projects';
const NO_DIRECTORY = 'directory must be an absolute path';

const lstatOrNull = (target) => {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
};

const isRealDirectory = (target) => lstatOrNull(target)?.isDirectory() === true;

const filesUnder = (dir, prefix, found) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) filesUnder(path.join(dir, entry.name), rel, found);
    else if (entry.isFile()) {
      found.push(rel);
      if (found.length > MAX_FILES) throw new MittrToolError(TOO_MANY, 413);
    }
  }
  return found;
};

const at = (root, rel) => path.join(root, ...rel.split('/'));

export const scanMittrFolder = (projectDir) => {
  const source = path.join(projectDir, SOURCE_DIR);
  if (!isRealDirectory(source)) return { files: [], missing: [] };
  const files = [];
  for (const kind of COPIED_KINDS) {
    const dir = path.join(source, kind);
    if (isRealDirectory(dir)) filesUnder(dir, kind, files);
  }
  files.sort();
  const target = path.join(projectDir, TARGET_DIR);
  return { files, missing: files.filter((rel) => lstatOrNull(at(target, rel)) === null) };
};

const folderFor = (target, rel) => {
  let current = target;
  for (const part of rel.split('/').slice(0, -1)) {
    current = path.join(current, part);
    const stat = lstatOrNull(current);
    if (!stat) fs.mkdirSync(current);
    else if (!stat.isDirectory()) return null;
  }
  return current;
};

export const copyMittrFolder = (projectDir) => {
  const { files } = scanMittrFolder(projectDir);
  const source = path.join(projectDir, SOURCE_DIR);
  const target = path.join(projectDir, TARGET_DIR);
  const targetStat = lstatOrNull(target);
  if (targetStat && !targetStat.isDirectory()) throw new MittrToolError(TARGET_NOT_A_FOLDER, 409);
  const copied = [];
  const skipped = [];
  if (files.length > 0 && !targetStat) fs.mkdirSync(target);
  for (const rel of files) {
    const from = at(source, rel);
    if (lstatOrNull(at(target, rel)) !== null || !lstatOrNull(from)?.isFile() || folderFor(target, rel) === null) {
      skipped.push(rel);
      continue;
    }
    try {
      fs.copyFileSync(from, at(target, rel), fs.constants.COPYFILE_EXCL);
      copied.push(rel);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      skipped.push(rel);
    }
  }
  return { copied, skipped };
};

export function createProjectFolderNotices({ dataDir }) {
  const filePath = path.join(dataDir, NOTICES_FILE);
  const read = () => {
    try {
      const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return isPlainObject(stored) && Array.isArray(stored.answered) ? stored.answered.filter((entry) => entry === String(entry)) : [];
    } catch {
      return [];
    }
  };
  return {
    answered: (projectDir) => read().includes(projectDir),
    answer: (projectDir) => {
      const answered = read();
      if (answered.includes(projectDir)) return;
      fs.mkdirSync(dataDir, { recursive: true });
      writePrivateAtomic(filePath, `${JSON.stringify({ answered: [...answered, projectDir] }, null, 2)}\n`);
    },
  };
}

const realPathOrNull = (target) => {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
};

export function registerProjectFolderRoutes(app, { express, host, requestScope, projects, notices, logger = console }) {
  const fromThisMac = (req, res, next) => (isLocalRequest(req, { host, requestScope }) ? next() : res.status(403).json({ error: ONLY_ON_THIS_MAC }));
  const readJson = jsonBody(express, { limit: BODY_LIMIT });

  const knownProject = async (body) => {
    const directory = body?.directory;
    if (directory !== String(directory ?? 0) || !path.isAbsolute(directory)) throw new MittrToolError(NO_DIRECTORY, 400);
    const real = realPathOrNull(directory);
    if (!real) return null;
    const listed = (await projects()).map((entry) => (entry?.path === String(entry?.path ?? 0) ? realPathOrNull(entry.path) : null));
    return listed.includes(real) ? real : null;
  };

  const answer = (work) => async (req, res) => {
    try {
      return res.json(await work(req));
    } catch (error) {
      if (error instanceof MittrToolError) return res.status(error.statusCode).json({ error: error.message });
      logger.warn('[mittr] a project folder route failed:', error?.name ?? 'Error');
      return res.status(500).json({ error: 'The project folder could not be copied' });
    }
  };

  app.post(`${PROJECT_FOLDER_ROUTE}/status`, fromThisMac, readJson, answer(async (req) => {
    const project = await knownProject(req.body);
    if (!project || notices.answered(project)) return { offer: false, files: [] };
    const { missing } = scanMittrFolder(project);
    return { offer: missing.length > 0, files: missing };
  }));

  app.post(`${PROJECT_FOLDER_ROUTE}/copy`, fromThisMac, readJson, answer(async (req) => {
    const project = await knownProject(req.body);
    if (!project) throw new MittrToolError(NOT_A_PROJECT, 404);
    const result = copyMittrFolder(project);
    notices.answer(project);
    return result;
  }));

  app.post(`${PROJECT_FOLDER_ROUTE}/dismiss`, fromThisMac, readJson, answer(async (req) => {
    const project = await knownProject(req.body);
    if (!project) throw new MittrToolError(NOT_A_PROJECT, 404);
    notices.answer(project);
    return { answered: true };
  }));
}

export function setupMittrProjectFolders(context, { logger = console } = {}) {
  const { app, express, host, requestScope, dataDir, settings } = context;
  if (!host || !settings) return;
  registerProjectFolderRoutes(app, {
    express,
    host,
    requestScope,
    projects: async () => {
      const stored = await settings.read();
      return Array.isArray(stored?.projects) ? stored.projects : [];
    },
    notices: createProjectFolderNotices({ dataDir }),
    logger,
  });
}
