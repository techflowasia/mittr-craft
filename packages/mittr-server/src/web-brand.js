import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BRAND_FILE = path.join(here, 'web-brand.json');
const DEFAULT_DIST_DIR = path.resolve(here, '..', '..', 'web', 'dist');
const SHELL = 'index.html';
const MANIFEST_ROUTE = '/manifest.webmanifest';
const IMMUTABLE = 'public, max-age=31536000, immutable';

const patternOf = (file) => new RegExp(`^${file.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);

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

export const createBrandedWeb = ({ distDir, brand }) => {
  const entries = brand.files.map((entry) => ({ ...entry, pattern: patternOf(entry.file) }));
  const cache = new Map();

  const serves = (relative) => entries.some((entry) => entry.pattern.test(relative));

  const read = async (relative) => {
    const original = await fs.promises.readFile(path.join(distDir, relative), 'utf8').catch(() => null);
    if (original === null) return null;
    const branded = entries
      .filter((entry) => entry.pattern.test(relative))
      .reduce((text, entry) => text.replaceAll(entry.from, entry.to), original);
    return branded === original ? null : branded;
  };

  const content = (relative) => {
    if (!cache.has(relative)) cache.set(relative, read(relative));
    return cache.get(relative);
  };

  const manifest = (body) => {
    let parsed;
    try {
      parsed = JSON.parse(String(body));
    } catch {
      return body;
    }
    if (parsed === null || typeof parsed !== 'object') return body;
    const { name, description } = brand.manifest;
    for (const key of ['name', 'short_name']) {
      if (parsed[key] === name.from) parsed[key] = name.to;
    }
    if (parsed.description === description.from) parsed.description = description.to;
    return JSON.stringify(parsed);
  };

  return { serves, content, manifest };
};

const relativeOf = (requestPath) => {
  if (requestPath === '/') return SHELL;
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/') || decoded.includes('\\') || decoded.split('/').includes('..')) return null;
  return decoded.slice(1);
};

const sendBranded = (res, relative, text) => {
  if (relative.startsWith('assets/')) res.setHeader('Cache-Control', IMMUTABLE);
  if (relative === 'sw.js') res.setHeader('Cache-Control', 'no-store');
  res.type(path.extname(relative));
  res.send(text);
};

export const registerBrandedWeb = (context, { env, brand = readWebBrand(), logger = context.logger ?? console } = {}) => {
  if (!brand) return { enabled: false };
  const distDir = webDistDir(env);
  const shellFile = path.join(distDir, SHELL);
  let shell;
  try {
    shell = fs.readFileSync(shellFile, 'utf8');
  } catch {
    return { enabled: false };
  }
  if (!brand.files.some((entry) => entry.file === SHELL && shell.includes(entry.from))) return { enabled: false };

  const web = createBrandedWeb({ distDir, brand });
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
    const relative = relativeOf(req.path);
    if (relative !== null && web.serves(relative)) {
      web.content(relative).then((text) => (text === null ? next() : sendBranded(res, relative, text)), next);
      return;
    }
    const sendFile = res.sendFile;
    res.sendFile = function sendBrandedShell(file, ...rest) {
      if (path.resolve(String(file)) !== shellFile) return sendFile.call(this, file, ...rest);
      web.content(SHELL).then(
        (text) => (text === null ? sendFile.call(this, file, ...rest) : sendBranded(res, SHELL, text)),
        (error) => next(error),
      );
      return undefined;
    };
    next();
  });

  logger.log(`[mittr] the web UI in ${distDir} is served with the MittrCraft brand`);
  return { enabled: true, distDir };
};
