import fs from 'node:fs';
import http from 'node:http';
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
    const call = { url: String(url), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined, signal: init.signal };
    calls.push(call);
    return respond(call, calls.length);
  };
  impl.calls = calls;
  return impl;
};

/** Listens on a loopback port, closed after the test, and returns its base URL. */
export const listen = async (t, handler) => {
  const server = await new Promise((resolve) => {
    const listening = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}`;
};

/** Mounts an express app on a loopback port and returns a JSON client for it, with its `base` URL. */
export const serve = async (t, app) => {
  const base = await listen(t, app);
  const call = async (method, route, body) => {
    const response = await fetch(base + route, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  call.base = base;
  return call;
};

/** A promise and the function that settles it, for holding a fetch mid-flight. */
export const deferred = () => {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
};
