import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MARKER_PNG, PROVEN_IMAGE_PART } from '../../../../../scripts/mittr/probe-tool-plugin.mjs';
import { SCREENSHOT_DIRECTORY, writeScreenshot } from '../../../../web/server/lib/openchamber-control/screenshots.js';
import { MittrToolError } from './registry.js';
import { MAX_IMAGE_BYTES, attachableImage, imageContent, readCapture, saveScreenshot } from './screenshots.js';

const REFUSAL = 'That image is not a saved screenshot of this project';
const PNG = Buffer.from(MARKER_PNG, 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const pngOfSize = (size) => Buffer.concat([PNG, Buffer.alloc(size - PNG.length)]);

const tempProject = (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-shots-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, SCREENSHOT_DIRECTORY), { recursive: true });
  return { root, project };
};

const save = (project, name, bytes = PNG) => {
  fs.writeFileSync(path.join(project, SCREENSHOT_DIRECTORY, name), bytes);
  return `.openchamber/screenshots/${name}`;
};

const read = (project, relativePath, files) => readCapture({ directory: project, relativePath, folder: SCREENSHOT_DIRECTORY, files });

const refused = async (promise) => {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof MittrToolError);
    assert.equal(error.message, REFUSAL);
    assert.equal(error.statusCode, 400);
    return true;
  });
};

test('the image part has the shape the engine accepts', () => {
  assert.deepEqual(imageContent({ base64: MARKER_PNG, mime: 'image/png', name: 'probe.png' }), PROVEN_IMAGE_PART);
});

test('a capture inside the screenshots folder is attached as an image part', async (t) => {
  const { project } = tempProject(t);
  const relativePath = save(project, 'home-page-2026-10-21T01-02-03-456.png');
  assert.deepEqual(await read(project, relativePath), { base64: MARKER_PNG, mime: 'image/png' });

  for (const [extension, mime, bytes] of [['jpg', 'image/jpeg', JPEG], ['jpeg', 'image/jpeg', JPEG], ['webp', 'image/webp', WEBP], ['PNG', 'image/png', PNG]]) {
    assert.deepEqual(await read(project, save(project, `shot.${extension}`, bytes)), { base64: bytes.toString('base64'), mime });
  }
});

test('a path outside .openchamber/screenshots is refused', async (t) => {
  const { root, project } = tempProject(t);
  fs.writeFileSync(path.join(project, 'x.png'), Buffer.from(MARKER_PNG, 'base64'));
  fs.writeFileSync(path.join(root, 'x.png'), Buffer.from(MARKER_PNG, 'base64'));
  fs.symlinkSync(path.join(root, 'x.png'), path.join(project, SCREENSHOT_DIRECTORY, 'linked.png'));

  for (const relativePath of [
    '../x.png',
    '/etc/x.png',
    path.join(project, 'x.png'),
    'x.png',
    '.openchamber/screenshots/../../x.png',
    '.openchamber/screenshots/../screenshots/../../x.png',
    '.openchamber/screenshots/linked.png',
    '.openchamber/screenshots/missing.png',
    '.openchamber/screenshots/notes.txt',
    '.openchamber/screenshots',
    '',
    undefined,
  ]) {
    await refused(read(project, relativePath));
  }
  save(project, 'notes.txt', Buffer.from('text'));
  await refused(read(project, '.openchamber/screenshots/notes.txt'));
  fs.mkdirSync(path.join(project, SCREENSHOT_DIRECTORY, 'folder.png'));
  await refused(read(project, '.openchamber/screenshots/folder.png'));
});

test('a symlinked .openchamber is refused', async (t) => {
  const { root, project } = tempProject(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(outside, 'screenshots'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'screenshots', 'x.png'), Buffer.from(MARKER_PNG, 'base64'));
  fs.rmSync(path.join(project, '.openchamber'), { recursive: true });
  fs.symlinkSync(outside, path.join(project, '.openchamber'));

  await refused(read(project, '.openchamber/screenshots/x.png'));
});

test('a file over 5 MiB is not attached and the reply says where it is', async (t) => {
  const { project } = tempProject(t);
  assert.equal(MAX_IMAGE_BYTES, 5 * 1024 * 1024);
  const atLimit = save(project, 'limit.png', pngOfSize(MAX_IMAGE_BYTES));
  assert.equal(Buffer.from((await read(project, atLimit)).base64, 'base64').length, MAX_IMAGE_BYTES);
  const over = save(project, 'big.png', pngOfSize(MAX_IMAGE_BYTES + 1));
  assert.deepEqual(await read(project, over), { tooLarge: true });

  const small = { path: '.openchamber/screenshots/a.png', image: { base64: MARKER_PNG, mime: 'image/png' } };
  assert.deepEqual(attachableImage(small), small);
  const big = { path: '.openchamber/screenshots/b.png', image: { base64: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64'), mime: 'image/png' } };
  assert.deepEqual(attachableImage(big), { path: '.openchamber/screenshots/b.png', image: { tooLarge: true } });
  assert.deepEqual(attachableImage({ url: 'http://a.test/' }), { url: 'http://a.test/' });
  assert.equal(attachableImage(null), null);
});

test('a file that is not the image its name says is refused', async (t) => {
  const { project } = tempProject(t);
  await refused(read(project, save(project, 'x.png', Buffer.from('just some text, not a picture'))));
  await refused(read(project, save(project, 'empty.png', Buffer.alloc(0))));
  await refused(read(project, save(project, 'png-named.jpg', PNG)));
  await refused(read(project, save(project, 'jpeg-named.webp', JPEG)));
  await refused(read(project, save(project, 'riff-only.webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(8)]))));
  await refused(read(project, save(project, 'text-over-cap.png', Buffer.alloc(MAX_IMAGE_BYTES + 1, 0x41))));
});

test('a file swapped for a symlink or another file around the open is refused', async (t) => {
  const { root, project } = tempProject(t);
  const outside = path.join(root, 'outside.png');
  fs.writeFileSync(outside, PNG);
  const relativePath = save(project, 'swapped.png');
  const target = path.join(project, relativePath);
  const swapThenOpen = { ...fs.promises, open: async (file, flags) => {
    fs.rmSync(target);
    fs.symlinkSync(outside, target);
    return fs.promises.open(file, flags);
  } };
  await refused(read(project, relativePath, swapThenOpen));

  const replaced = save(project, 'replaced.png');
  const replacedTarget = path.join(project, replaced);
  const openThenReplace = { ...fs.promises, open: async (file, flags) => {
    const handle = await fs.promises.open(file, flags);
    fs.writeFileSync(`${replacedTarget}.next`, PNG);
    fs.renameSync(`${replacedTarget}.next`, replacedTarget);
    return handle;
  } };
  await refused(read(project, replaced, openThenReplace));
});

test('a file that grows past the cap after it is opened is not attached', async (t) => {
  const { project } = tempProject(t);
  const relativePath = save(project, 'growing.png');
  const target = path.join(project, relativePath);
  const openThenGrow = { ...fs.promises, open: async (file, flags) => {
    const handle = await fs.promises.open(file, flags);
    fs.appendFileSync(target, Buffer.alloc(MAX_IMAGE_BYTES));
    return handle;
  } };
  assert.deepEqual(await read(project, relativePath, openThenGrow), { tooLarge: true });
});

test('our screenshots land under .openchamber/screenshots with the label slug', async (t) => {
  const { project } = tempProject(t);
  const control = { writeScreenshot, SCREENSHOT_DIRECTORY };

  const saved = await saveScreenshot({ control, directory: project, base64: MARKER_PNG, mime: 'image/png', label: 'Before Fix!' });

  assert.match(saved.path, /^\.openchamber\/screenshots\/before-fix-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}\.png$/);
  assert.deepEqual(saved.image, { base64: MARKER_PNG, mime: 'image/png' });
  assert.deepEqual(fs.readFileSync(path.join(project, saved.path)), Buffer.from(MARKER_PNG, 'base64'));
  assert.deepEqual(await read(project, saved.path), saved.image);
});

test('a screenshot without a session directory is refused and nothing is written', async () => {
  const writes = [];
  const control = { writeScreenshot: async (args) => { writes.push(args); return { path: 'x', absolutePath: '/x' }; }, SCREENSHOT_DIRECTORY };
  await assert.rejects(saveScreenshot({ control, directory: undefined, base64: MARKER_PNG, mime: 'image/png', label: 'x' }), (error) => {
    assert.ok(error instanceof MittrToolError);
    assert.equal(error.statusCode, 400);
    assert.equal(error.message, 'A project directory is required to save a screenshot');
    return true;
  });
  assert.deepEqual(writes, []);
});
