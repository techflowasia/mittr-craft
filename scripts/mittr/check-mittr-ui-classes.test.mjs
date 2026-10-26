import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { classesIn, missingMittrUiClasses } from './check-mittr-ui-classes.mjs';

test('class names are read back from built CSS with their escapes undone', () => {
  const classes = classesIn('.flex{display:flex}.hover\\:bg-muted:hover{x:y}.bottom-\\[0\\.375rem\\]{x:y}.\\31 0{x:y}.w-1\\/2,.\\@xl\\:grid-cols-2{x:y}');
  for (const name of ['flex', 'hover:bg-muted', 'bottom-[0.375rem]', '10', 'w-1/2', '@xl:grid-cols-2']) assert.ok(classes.has(name), name);
  assert.equal(classesIn('/*! tailwindcss | https://tailwindcss.com */.flex{}').has('com'), false);
});

test('a utility only mittr-ui uses is reported, one the UI build ships is not', async (t) => {
  const sources = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-ui-classes-'));
  t.after(() => fs.rmSync(sources, { recursive: true, force: true }));
  fs.writeFileSync(path.join(sources, 'Bar.tsx'), 'export const Bar = () => <div className="fixed bottom-48 flex motion-safe:animate-spin" />;\n');
  fs.writeFileSync(path.join(sources, 'Bar.test.tsx'), 'const only = "bottom-72";\n');
  assert.deepEqual(await missingMittrUiClasses({ sources }), ['bottom-48', 'motion-safe:animate-spin']);
  assert.deepEqual(await missingMittrUiClasses({ sources, builtCss: '.fixed{}.flex{}.bottom-48{}.motion-safe\\:animate-spin{}' }), []);
});

test('every Tailwind utility mittr-ui uses is in the CSS the UI build ships, so the voice bar keeps its place', async () => {
  assert.deepEqual(await missingMittrUiClasses(), []);
});
