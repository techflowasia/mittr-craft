#!/usr/bin/env node
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const UNESCAPE = /\\(?:([0-9a-fA-F]{1,6}) ?|([\s\S]))/g;
const CLASS_SELECTOR = /\.((?:\\[0-9a-fA-F]{1,6} ?|\\[\s\S]|[\w-])+)/g;

const unescapeClass = (escaped) => escaped.replace(UNESCAPE, (_all, hex, char) => (hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : char));

export const classesIn = (css) => {
  const classes = new Set();
  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(CLASS_SELECTOR)) classes.add(unescapeClass(match[1]));
  return classes;
};

const loadTailwind = async (root) => {
  const plugin = fs.realpathSync(path.join(root, 'node_modules', '@tailwindcss', 'postcss'));
  const require = createRequire(path.join(plugin, 'package.json'));
  const [{ compile }, { Scanner }] = await Promise.all([
    import(pathToFileURL(require.resolve('@tailwindcss/node')).href),
    import(pathToFileURL(require.resolve('@tailwindcss/oxide')).href),
  ]);
  return { compile, Scanner };
};

export async function missingMittrUiClasses({ root = repoRoot, sources = path.join(root, 'packages', 'mittr-ui', 'src'), builtCss = null } = {}) {
  const { compile, Scanner } = await loadTailwind(root);
  const uiSource = path.join(root, 'packages', 'ui', 'src');
  const entry = fs.readFileSync(path.join(uiSource, 'index.css'), 'utf8');
  const compiler = () => compile(entry, { base: uiSource, onDependency: () => {} });

  const candidates = new Scanner({
    sources: [
      { base: sources, pattern: '**/*.{ts,tsx}', negated: false },
      { base: sources, pattern: '**/*.test.{ts,tsx}', negated: true },
    ],
  }).scan();
  const ours = classesIn((await compiler()).build(candidates));

  let shipped;
  if (builtCss !== null) {
    shipped = classesIn(builtCss);
  } else {
    const ui = await compiler();
    const detected = ui.root === 'none' ? [] : [ui.root ?? { base: path.join(root, 'packages', 'web'), pattern: '**/*', negated: false }];
    shipped = classesIn(ui.build(new Scanner({ sources: [...ui.sources, ...detected] }).scan()));
  }
  return [...new Set(candidates.filter((candidate) => ours.has(candidate) && !shipped.has(candidate)))].sort();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const files = args.flatMap((arg, index) => (args[index - 1] === '--css' ? [arg] : []));
  const builtCss = files.length > 0 ? files.map((file) => fs.readFileSync(file, 'utf8')).join('\n') : null;
  const missing = await missingMittrUiClasses({ builtCss });
  if (missing.length > 0) {
    console.error(`mittr-ui uses ${missing.length} Tailwind utilities the UI build does not ship:\n${missing.map((name) => `  ${name}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`mittr-ui Tailwind utilities: all shipped${files.length > 0 ? ` (checked against ${files.length} built stylesheet${files.length === 1 ? '' : 's'})` : ''}`);
}
