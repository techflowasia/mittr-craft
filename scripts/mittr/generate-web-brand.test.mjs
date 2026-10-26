import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { REPO_ROOT, generateWebBrand } from '../../packages/mittr-server/src/web-brand-source.js';
import { writeWebBrand } from './generate-web-brand.mjs';

const tempDir = (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-web-brand-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const fixtureBrand = (t, extra = []) => {
  const dir = tempDir(t);
  const pwa = '.product/web/server/lib/opencode/pwa-manifest-routes.js';
  fs.writeFileSync(path.join(dir, 'visible-strings.json'), JSON.stringify([
    { file: 'resources/web-dist/index.html', from: 'OpenChamber', to: 'MittrCraft', count: 2 },
    { file: pwa, from: "const DEFAULT_PWA_APP_NAME = 'OpenChamber';", to: "const DEFAULT_PWA_APP_NAME = 'MittrCraft';", count: 1 },
    { file: pwa, from: "'Web interface companion'", to: "'A workspace'", count: 1 },
    { file: 'packages/desktop/only.js', from: 'x', to: 'y', count: 1 },
    ...extra,
  ]));
  fs.writeFileSync(path.join(dir, 'visible-strings.prod.json'), '[]');
  return dir;
};

test('a new visible string reaches the web brand', (t) => {
  const base = generateWebBrand({ brandDir: fixtureBrand(t) });
  const added = { file: 'resources/web-dist/assets/*.js', from: 'Old text', to: 'New text', count: 4 };
  const grown = generateWebBrand({ brandDir: fixtureBrand(t, [added]) });

  assert.equal(base.files.length, 1);
  assert.deepEqual(grown.files, [...base.files, { ...added, file: 'assets/*.js' }]);
  assert.deepEqual(grown.manifest, base.manifest);
  assert.deepEqual(base.manifest, {
    name: { from: 'OpenChamber', to: 'MittrCraft' },
    description: { from: 'Web interface companion', to: 'A workspace' },
  });
});

test('the generated file ends with a newline and is indented by two spaces', (t) => {
  const file = path.join(tempDir(t), 'web-brand.json');
  writeWebBrand({ brandDir: fixtureBrand(t), file });
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.endsWith('}\n') && !text.endsWith('\n\n'));
  assert.ok(text.startsWith('{\n  "files": [\n    {\n      "file": '));
  assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`);
});

test('the committed brand directory is the default source', () => {
  assert.deepEqual(generateWebBrand(), generateWebBrand({ brandDir: path.join(REPO_ROOT, 'brand') }));
});
