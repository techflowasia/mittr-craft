#!/usr/bin/env node
/**
 * Scans a built MittrCraft app for upstream product names a person could see.
 *
 *   node scripts/mittr/brand-leak-scan.mjs <path to .app> [--json]
 *
 * It reads the app's Info.plist files, the staged web UI under
 * `Contents/Resources/web-dist` (the UI the desktop window and its loopback
 * server both serve), and from `app.asar` the app's own files at its root
 * (`dist-bundle/*.mjs`, the preload, the product plugins, the package
 * manifest) and the web server's code, extracted to a temporary directory. In JavaScript only
 * string literals count, so identifiers, imports and comments do not, and
 * neither does text passed to `console.*`; other text files are read line by
 * line, without markup comments.
 *
 * A hit is explained, and not printed, when:
 * - the literal is the value of a translation key in a dictionary object
 *   (`"key": "value"`) and what the running UI shows for that key and value,
 *   after the product UI plugin's overrides and substitutions, names no
 *   upstream product; or
 * - an entry of `brand/leak-allowlist.json` (`{ file, snippet, reason }`)
 *   covers it: `file` is the app-relative path, where `*` stands for any run
 *   of characters other than `/` (content hashes), and `snippet` is either
 *   text of the literal or line around the hit, or source code that contains
 *   the whole literal (for a short literal such as a bare name, whose own text
 *   says nothing about where it is used). An entry may also give `key`, the
 *   object property the literal is the value of, to cover that property's
 *   values only (one entry for a label in every locale of a table).
 *
 * Every other hit is printed as `file:line: snippet` and the scan exits 1. An
 * allowlist entry that explains nothing also exits 1, so the list cannot keep
 * entries for strings upstream has since removed.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';
import { z } from 'zod';

import { resolveBunExecutable } from '../lib/bun-executable.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const defaultAllowlist = path.join(repoRoot, 'brand', 'leak-allowlist.json');

export const NEEDLES = ['OpenChamber', 'OpenCode', 'openchamber://'];

const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const TEXT_EXTENSIONS = new Set(['.html', '.css', '.json', '.webmanifest', '.svg', '.txt', '.plist', '.xml']);
const SNIPPET_CONTEXT = 40;
const CODE_CONTEXT = 60;

const allowlistSchema = z.array(z.object({
  file: z.string().min(1),
  key: z.string().min(1).optional(),
  snippet: z.string().min(1),
  reason: z.string().min(1),
}).strict());

/** Every needle occurrence in `text`, as `[start, end)` offsets. */
export const findNeedles = (text) => {
  const found = [];
  for (const needle of NEEDLES) {
    for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + needle.length)) {
      found.push({ start: index, end: index + needle.length });
    }
  }
  return found.sort((a, b) => a.start - b.start);
};

const hasNeedle = (text) => NEEDLES.some((needle) => text.includes(needle));

const isStringNode = (node) => ts.isStringLiteral(node)
  || ts.isNoSubstitutionTemplateLiteral(node)
  || ts.isTemplateHead(node)
  || ts.isTemplateMiddle(node)
  || ts.isTemplateTail(node);

// Text passed to `console.*` is log output, which a person using the app does
// not see.
const isConsoleArgument = (node) => {
  for (let current = node.parent; current && !ts.isSourceFile(current); current = current.parent) {
    if (ts.isFunctionLike(current)) return false;
    if (ts.isCallExpression(current)) {
      const callee = current.expression;
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'console') return true;
    }
  }
  return false;
};

// The key when the literal is the value of an object property: that is how a
// translation dictionary looks in the bundle.
const propertyKey = (node) => {
  const { parent } = node;
  if (!parent || !ts.isPropertyAssignment(parent) || parent.initializer !== node) return undefined;
  const { name } = parent;
  return ts.isStringLiteral(name) || ts.isIdentifier(name) || ts.isNoSubstitutionTemplateLiteral(name) ? name.text : undefined;
};

/** String literals and template text in a script, with their 1-based line. */
export const scriptStrings = (source, fileName) => {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const strings = [];
  const visit = (node) => {
    if (isStringNode(node) && hasNeedle(node.text) && !isConsoleArgument(node)) {
      const start = node.getStart(sourceFile);
      const codeStart = Math.max(0, start - CODE_CONTEXT);
      strings.push({
        line: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
        text: node.text,
        code: source.slice(codeStart, node.end + CODE_CONTEXT),
        literal: { start: start - codeStart, end: node.end - codeStart },
        key: propertyKey(node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return strings;
};

// Comments are not rendered; blank them out, keeping line numbers. HTML may
// hold style and script blocks, so it loses both comment kinds.
const COMMENTS = {
  '.html': [/<!--[\s\S]*?-->/g, /\/\*[\s\S]*?\*\//g],
  '.svg': [/<!--[\s\S]*?-->/g],
  '.xml': [/<!--[\s\S]*?-->/g],
  '.plist': [/<!--[\s\S]*?-->/g],
  '.css': [/\/\*[\s\S]*?\*\//g],
};
const withoutComments = (source, extension) => (COMMENTS[extension] ?? [])
  .reduce((text, pattern) => text.replace(pattern, (comment) => comment.replace(/[^\n]/g, ' ')), source);

const textLines = (source) => source.split(/\r?\n/)
  .map((text, index) => ({ line: index + 1, text }))
  .filter(({ text }) => hasNeedle(text));

/** One hit per needle occurrence, inside the string or line that holds it. */
export const scanSource = ({ file, source }) => {
  if (!hasNeedle(source)) return [];
  const extension = path.extname(file);
  if (SCRIPT_EXTENSIONS.has(extension)) {
    return scriptStrings(source, file)
      .flatMap((string) => findNeedles(string.text).map((occurrence) => ({ file, ...string, ...occurrence })));
  }
  return textLines(withoutComments(source, extension))
    .flatMap(({ line, text }) => findNeedles(text).map((occurrence) => ({ file, line, text, code: text, literal: occurrence, ...occurrence })));
};

export const snippetOf = ({ text, start, end }) => text.slice(Math.max(0, start - SNIPPET_CONTEXT), end + SNIPPET_CONTEXT);

// A short literal is printed with the code around it, which is what an
// allowlist entry for it has to quote.
const describe = (hit) => {
  const snippet = snippetOf(hit);
  return snippet === hit.text && hit.code !== hit.text ? `${JSON.stringify(snippet)} in ${JSON.stringify(hit.code)}` : JSON.stringify(snippet);
};

const fileMatcher = (pattern) => new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);

const spans = (text, snippet, { start, end }) => {
  for (let index = text.indexOf(snippet); index !== -1; index = text.indexOf(snippet, index + 1)) {
    if (index <= start && index + snippet.length >= end) return true;
  }
  return false;
};

const covers = (entry, hit) => (entry.key === undefined || entry.key === hit.key)
  && (spans(hit.text, entry.snippet, hit) || spans(hit.code, entry.snippet, hit.literal));

/**
 * Sorts hits into translation keys (ids, never shown), translations the
 * product plugin rewrites, allowlisted hits and leaks. `translations.keys` is
 * every translation key; `translations.values` maps a key to its dictionary
 * values (upstream's in every locale, and the plugin's overrides), each mapped
 * to what the running UI shows for it.
 */
export const classifyHits = ({ hits, allowlist, translations }) => {
  const entries = allowlistSchema.parse(allowlist).map((entry) => ({ entry, matchFile: fileMatcher(entry.file), used: 0 }));
  const result = { keys: [], translated: [], allowlisted: [], leaks: [] };
  for (const hit of hits) {
    if (translations.keys.has(hit.text)) {
      result.keys.push(hit);
      continue;
    }
    const shown = hit.key === undefined ? undefined : translations.values.get(hit.key)?.get(hit.text);
    if (shown && !shown.some(hasNeedle)) {
      result.translated.push(hit);
      continue;
    }
    const match = entries.find((candidate) => candidate.matchFile.test(hit.file) && covers(candidate.entry, hit));
    if (match) {
      match.used += 1;
      result.allowlisted.push({ ...hit, reason: match.entry.reason });
    } else {
      result.leaks.push(shown ? { ...hit, translation: true } : hit);
    }
  }
  result.unusedAllowlist = entries.filter((candidate) => candidate.used === 0).map((candidate) => candidate.entry);
  return result;
};

// Runs the UI's own overlay over every locale dictionary, in bun because the
// sources are TypeScript and TSX. Prints every translation key, and
// `[key, value, shown]` triples: each upstream value with what the UI shows
// for it, and each plugin override with itself.
const TRANSLATION_DUMP = `
const root = process.argv[1];
const fs = await import('node:fs');
await import(root + '/packages/mittr-ui/src/product-ui-plugin.tsx');
const { overlayDictionary } = await import(root + '/packages/ui/src/lib/product-plugins.ts');
const dir = root + '/packages/ui/src/lib/i18n/messages';
const keys = new Set();
const triples = [];
for (const file of fs.readdirSync(dir).filter((name) => /^[a-z]{2}(-[A-Z]{2})?\\.ts$/.test(name))) {
  const locale = file.slice(0, -3);
  const { dict } = await import(dir + '/' + file);
  const shown = overlayDictionary(locale, dict);
  for (const key of Object.keys(dict)) {
    keys.add(key);
    triples.push([key, dict[key], shown[key]]);
    if (shown[key] !== dict[key]) triples.push([key, shown[key], shown[key]]);
  }
}
process.stdout.write(JSON.stringify({ keys: [...keys], triples }));
`;

export const loadTranslations = ({ root = repoRoot } = {}) => {
  const result = spawnSync(resolveBunExecutable(), ['-e', TRANSLATION_DUMP, root], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`reading the translation dictionaries failed:\n${result.stderr}`);
  const { keys, triples } = JSON.parse(result.stdout);
  const values = new Map();
  for (const [key, value, shown] of triples) {
    if (!hasNeedle(value)) continue;
    const byValue = values.get(key) ?? new Map();
    byValue.set(value, [...(byValue.get(value) ?? []), shown]);
    values.set(key, byValue);
  }
  return { keys: new Set(keys), values };
};

export const loadAsar = () => {
  // `@electron/asar` comes with electron-builder; resolve it through the
  // packages that depend on it instead of declaring it again.
  let require = createRequire(path.join(repoRoot, 'packages', 'electron', 'package.json'));
  require = createRequire(require.resolve('electron-builder/package.json'));
  require = createRequire(require.resolve('app-builder-lib/package.json'));
  return require('@electron/asar');
};

const walk = (dir, prefix) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  const relative = `${prefix}/${entry.name}`;
  return entry.isDirectory() ? walk(full, relative) : [{ file: relative, full }];
});

const isScannable = (file) => SCRIPT_EXTENSIONS.has(path.extname(file)) || TEXT_EXTENSIONS.has(path.extname(file));

// The app's own files at the asar root, and the web server, whose messages
// reach the UI as errors, statuses and pages. Other packages in
// `node_modules` are third-party code; tests are not run by the app.
const SERVER_PREFIX = 'node_modules/@openchamber/web/server/';
const isScannedAsarFile = (file) => isScannable(file) && !/\.test\.[cm]?js$/.test(file)
  && (!file.startsWith('node_modules/') || file.startsWith(SERVER_PREFIX));

/** Extracts the app's own asar files into `targetDir` and lists them. */
export const extractAppFiles = ({ archive, targetDir, asar = loadAsar() }) => {
  const files = asar.listPackage(archive, { isPack: false })
    .map((entry) => entry.replace(/^[/\\]+/, '').split(path.sep).join('/'))
    .filter(isScannedAsarFile)
    .filter((file) => {
      try {
        return !asar.statFile(archive, file).files;
      } catch {
        return false;
      }
    });
  return files.map((file) => {
    const full = path.join(targetDir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, asar.extractFile(archive, file));
    return { file: `app.asar/${file}`, full };
  });
};

const appFiles = ({ appPath, extractDir }) => {
  const contents = path.join(appPath, 'Contents');
  const resources = path.join(contents, 'Resources');
  const frameworks = path.join(contents, 'Frameworks');
  const plists = [{ file: 'Info.plist', full: path.join(contents, 'Info.plist') }];
  if (fs.existsSync(frameworks)) {
    for (const name of fs.readdirSync(frameworks).filter((entry) => entry.endsWith('.app')).sort()) {
      plists.push({ file: `Frameworks/${name}/Info.plist`, full: path.join(frameworks, name, 'Contents', 'Info.plist') });
    }
  }
  const webDist = path.join(resources, 'web-dist');
  return [
    ...plists.filter(({ full }) => fs.existsSync(full)),
    ...(fs.existsSync(webDist) ? walk(webDist, 'web-dist').filter(({ file }) => isScannable(file)) : []),
    ...extractAppFiles({ archive: path.join(resources, 'app.asar'), targetDir: extractDir }),
  ];
};

export const scanApp = ({ appPath, allowlist, translations }) => {
  if (!fs.existsSync(path.join(appPath, 'Contents', 'Resources', 'app.asar'))) {
    throw new Error(`${appPath} is not a built app: Contents/Resources/app.asar is missing`);
  }
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-leak-scan-'));
  try {
    const files = appFiles({ appPath, extractDir });
    const hits = files.flatMap(({ file, full }) => scanSource({ file, source: fs.readFileSync(full, 'utf8') }));
    return { fileCount: files.length, ...classifyHits({ hits, allowlist, translations }) };
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
};

const formatHit = (hit) => `${hit.file}:${hit.line}: ${describe(hit)}${hit.translation ? ' (translation)' : ''}`;

const main = () => {
  const args = process.argv.slice(2);
  const appPath = args.find((arg) => !arg.startsWith('--'));
  if (!appPath) {
    console.error('Usage: node scripts/mittr/brand-leak-scan.mjs <path to .app> [--json]');
    process.exit(2);
  }
  const allowlist = JSON.parse(fs.readFileSync(defaultAllowlist, 'utf8'));
  const result = scanApp({ appPath: path.resolve(appPath), allowlist, translations: loadTranslations() });

  if (args.includes('--json')) {
    const view = (hit) => ({ file: hit.file, line: hit.line, snippet: snippetOf(hit), code: hit.code, reason: hit.reason });
    console.log(JSON.stringify({
      files: result.fileCount,
      keys: result.keys.length,
      translated: result.translated.map(view),
      allowlisted: result.allowlisted.map(view),
      leaks: result.leaks.map(view),
      unusedAllowlist: result.unusedAllowlist,
    }, null, 2));
  } else {
    for (const hit of result.leaks) console.log(formatHit(hit));
    for (const entry of result.unusedAllowlist) console.log(`unused allowlist entry: ${JSON.stringify(entry)}`);
    console.log(`[mittr] ${result.fileCount} files: ${result.keys.length} translation keys, ${result.translated.length} translated, ${result.allowlisted.length} allowlisted, ${result.leaks.length} unexplained, ${result.unusedAllowlist.length} unused allowlist entries`);
  }
  process.exit(result.leaks.length === 0 && result.unusedAllowlist.length === 0 ? 0 : 1);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    console.error(`[mittr] ${error.message}`);
    process.exit(2);
  }
}
