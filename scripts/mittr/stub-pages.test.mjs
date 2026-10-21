import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import { createStubPages } from './stub-pages.mjs';

const start = async () => {
  const pages = createStubPages();
  const port = await pages.listen(0);
  return { pages, port };
};

test('it listens on loopback only and serves the form, its thanks page and the style page', async () => {
  const { pages, port } = await start();
  try {
    assert.equal(pages.server.address().address, '127.0.0.1');
    const form = await fetch(`http://127.0.0.1:${port}/form`).then((r) => r.text());
    for (const part of ['name="name"', 'name="email"', '<select', 'type="submit"', 'action="/thanks"', 'id="footer"']) assert.ok(form.includes(part), part);
    const thanks = await fetch(`http://127.0.0.1:${port}/thanks?name=%3Cb%3ESomchai&email=a%40b.test&plan=pro`).then((r) => r.text());
    assert.ok(thanks.includes('Thanks, &lt;b&gt;Somchai'));
    assert.ok(thanks.includes('a@b.test'));
    const style = await fetch(`http://127.0.0.1:${port}/style`).then((r) => r.text());
    assert.match(style, /<h1[^>]*font-size:\s*32px/);
    assert.match(style, /<button[^>]*background-color:\s*#0a7/);
    const signIn = await fetch(`http://127.0.0.1:${port}/sign-in`).then((r) => r.text());
    assert.match(signIn, /type="password"/);
    const error = await fetch(`http://127.0.0.1:${port}/error`).then((r) => r.text());
    assert.match(error, /console\.error\(/);
  } finally {
    await pages.close();
  }
});

test('the redirect sends localhost to 127.0.0.1/landing and records the host of every request', async () => {
  const { pages, port } = await start();
  try {
    const moved = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/redirect', headers: { host: `localhost:${port}` } }, (res) => {
        res.resume();
        resolve({ status: res.statusCode, location: res.headers.location });
      }).on('error', reject);
    });
    assert.equal(moved.status, 302);
    assert.equal(moved.location, `http://127.0.0.1:${port}/landing`);
    const landing = await fetch(`http://127.0.0.1:${port}/landing`).then((r) => r.text());
    assert.ok(landing.includes('landing-marker'));
    const missing = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(missing.status, 404);
    assert.deepEqual(pages.requests().map(({ host, path }) => [host, path]), [
      [`localhost:${port}`, '/redirect'],
      [`127.0.0.1:${port}`, '/landing'],
      [`127.0.0.1:${port}`, '/nope'],
    ]);
  } finally {
    await pages.close();
  }
});
