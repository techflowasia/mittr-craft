import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { matcherFor } from './brand-matcher.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BRAND_FILE = path.join(here, 'web-brand.json');
const DEFAULT_DIST_DIR = path.resolve(here, '..', '..', 'web', 'dist');
const SHELL = 'index.html';
const MANIFEST_ROUTE = '/manifest.webmanifest';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const API_ONLY_FLAG = /^--api-only(=|$)/;

const patternOf = (file) => new RegExp(`^${file.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);

const isFlagOn = (value) => ['1', 'true'].includes(String(value ?? '').trim().toLowerCase());

export const readWebBrand = (file = BRAND_FILE) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

export const webDistDir = (env) => {
  const own = String(env.OPENCHAMBER_DIST_DIR ?? '').trim();
  return own ? path.resolve(own) : DEFAULT_DIST_DIR;
};

export const servesApiOnly = (env, argv) => isFlagOn(env.OPENCHAMBER_API_ONLY) || argv.some((arg) => API_ONLY_FLAG.test(String(arg)));

const listFiles = (distDir, entries) => {
  const folders = new Set(entries.map((entry) => path.posix.dirname(entry.file)));
  const files = [];
  for (const folder of folders) {
    let names;
    try {
      names = fs.readdirSync(path.join(distDir, folder), { withFileTypes: true }).filter((item) => item.isFile()).map((item) => item.name);
    } catch {
      continue;
    }
    for (const name of names) {
      const relative = folder === '.' ? name : `${folder}/${name}`;
      if (entries.some((entry) => entry.pattern.test(relative))) files.push(relative);
    }
  }
  return files.sort();
};

export const createBrandedWeb = ({ distDir, brand }) => {
  const entries = brand.files.map((entry) => ({ ...entry, pattern: patternOf(entry.file), matcher: matcherFor(entry.from) }));
  const known = new Set(listFiles(distDir, entries));
  const branded = new Map();
  const mismatches = [];

  const ready = (async () => {
    const texts = new Map();
    const originals = new Map();
    await Promise.all([...known].map(async (relative) => {
      const text = await fs.promises.readFile(path.join(distDir, relative), 'utf8').catch(() => null);
      if (text === null) return;
      texts.set(relative, text);
      originals.set(relative, text);
    }));
    for (const entry of entries) {
      const counted = [...texts.keys()]
        .filter((relative) => entry.pattern.test(relative))
        .map((relative) => ({ relative, count: entry.matcher.count(texts.get(relative)) }))
        .filter(({ count }) => count > 0);
      const found = counted.reduce((total, { count }) => total + count, 0);
      if (found !== entry.count) {
        mismatches.push({ file: entry.file, from: entry.from, expected: entry.count, found });
        continue;
      }
      for (const { relative } of counted) texts.set(relative, entry.matcher.replace(texts.get(relative), entry.to));
    }
    for (const [relative, text] of texts) {
      if (text !== originals.get(relative)) branded.set(relative, text);
    }
  })();

  const manifest = (body) => {
    let parsed;
    try {
      parsed = JSON.parse(String(body));
    } catch {
      return body;
    }
    if (parsed?.constructor !== Object) return body;
    const { name, description } = brand.manifest;
    for (const key of ['name', 'short_name']) {
      if (parsed[key] === name.from) parsed[key] = name.to;
    }
    if (parsed.description === description.from) parsed.description = description.to;
    return JSON.stringify(parsed);
  };

  return {
    ready,
    serves: (relative) => known.has(relative),
    known: () => [...known].sort(),
    files: () => [...branded.keys()].sort(),
    text: (relative) => branded.get(relative) ?? null,
    mismatches: () => [...mismatches],
    manifest,
  };
};

const sendBranded = (res, relative, text) => {
  if (relative.startsWith('assets/')) res.setHeader('Cache-Control', IMMUTABLE);
  if (relative === 'sw.js') res.setHeader('Cache-Control', 'no-store');
  res.type(path.extname(relative));
  res.send(text);
};

const describeMismatch = ({ file, from, expected, found }) => `${JSON.stringify(from.length > 80 ? `${from.slice(0, 77)}...` : from)} in ${file}: expected ${expected}, found ${found}`;

export const registerBrandedWeb = (context, { env, argv = process.argv, brand = readWebBrand(), logger = context.logger ?? console } = {}) => {
  if (!brand || servesApiOnly(env, argv)) return { enabled: false };
  const distDir = webDistDir(env);
  const shellFile = path.join(distDir, SHELL);
  let shell;
  try {
    shell = fs.readFileSync(shellFile, 'utf8');
  } catch {
    return { enabled: false };
  }
  if (!brand.files.some((entry) => entry.file === SHELL && matcherFor(entry.from).count(shell) > 0)) return { enabled: false };

  const web = createBrandedWeb({ distDir, brand });
  web.ready.then(() => {
    const mismatches = web.mismatches();
    if (mismatches.length === 0) return;
    logger.warn(`[mittr] ${mismatches.length} brand entries were left out of the web UI because they do not match it as the desktop build expects:\n${mismatches.map((mismatch) => `  ${describeMismatch(mismatch)}`).join('\n')}`);
  }, (error) => logger.warn('[mittr] the web UI brand could not be prepared:', error?.message ?? error));
  const { app } = context;

  app.get(MANIFEST_ROUTE, (_req, res, next) => {
    const send = res.send;
    res.send = function sendBrandedManifest(body) {
      res.send = send;
      return send.call(this, web.manifest(body));
    };
    next();
  });

  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const relative = req.path === '/' ? SHELL : req.path.slice(1);
    if (web.serves(relative)) {
      web.ready.then(() => {
        const text = web.text(relative);
        return text === null ? next() : sendBranded(res, relative, text);
      }, next);
      return;
    }
    const sendFile = res.sendFile;
    res.sendFile = function sendBrandedShell(file, ...rest) {
      if (path.resolve(String(file)) !== shellFile) return sendFile.call(this, file, ...rest);
      web.ready.then(() => {
        const text = web.text(SHELL);
        return text === null ? sendFile.call(this, file, ...rest) : sendBranded(res, SHELL, text);
      }, (error) => next(error));
      return undefined;
    };
    next();
  });

  logger.log(`[mittr] the web UI in ${distDir} is served with the MittrCraft brand`);
  return { enabled: true, distDir, web };
};
