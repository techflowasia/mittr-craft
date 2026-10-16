import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Stands in for the keychain and actually obscures the bytes, so a test that
// looks for a token on disk proves something.
export const encrypt = (text) => Buffer.from(Buffer.from(text, 'utf8').toString('base64'), 'utf8');
export const decrypt = (buffer) => Buffer.from(Buffer.from(buffer).toString('utf8'), 'base64').toString('utf8');

export const tempDataDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

export const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

/** A fetch that never leaves the process: `respond(call)` answers each request. */
export const fakeFetch = (respond = () => json({})) => {
  const calls = [];
  const impl = async (url, init = {}) => {
    const call = { url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    return respond(call, calls.length);
  };
  impl.calls = calls;
  return impl;
};

/** Mounts an express app on a loopback port and returns a JSON client for it. */
export const serve = async (t, app) => {
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (method, route, body) => {
    const response = await fetch(base + route, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
};
