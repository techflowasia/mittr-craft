import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// Upstream's merge rule, by path: the server hands plugins this very function.
import { mergeEngineConfig } from '../../../web/server/lib/server-plugins.js';

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

/**
 * The parts of the server's plugin context that reach the engine: the bound
 * port, a managed OpenCode whose ready listeners the test fires, the
 * managed-config refresh and upstream's own merge rule.
 */
export const fakeEngineContext = ({ port = 4100, enginePort = 4096 } = {}) => {
  const readyListeners = new Set();
  const refreshes = [];
  const restarts = [];
  const engine = {
    port: enginePort,
    url: (route = '/') => {
      if (engine.port === null) throw new Error('OpenCode port is not available');
      return `http://127.0.0.1:${engine.port}${route.startsWith('/') ? route : `/${route}`}`;
    },
    authHeaders: () => ({ Authorization: 'Basic b3BlbmNvZGU6cHc=' }),
    defaultDirectory: () => '/work',
    onReady: (listener) => {
      readyListeners.add(listener);
      return () => readyListeners.delete(listener);
    },
    restart: async (reason) => { restarts.push(reason); },
    refresh: async (reason) => { restarts.push(reason); },
  };
  const server = { port };
  return {
    context: {
      server: { port: () => server.port },
      opencode: engine,
      managedConfig: { refresh: async () => { refreshes.push(Date.now()); return { updated: true }; } },
      mergeEngineConfig,
    },
    server,
    engine,
    refreshes,
    restarts,
    readyListeners,
    fireReady: () => { for (const listener of readyListeners) listener(); },
  };
};

/** Waits until `predicate()` holds (or resolves to true), failing after `timeoutMs`. */
export const until = async (predicate, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/**
 * A fetch standing in for the engine's key routes, with its credential store
 * as the 2.0.22 engine keeps it: each connect adds an entry and makes it the
 * only active one for that integration. `answer(call)` may return a Response
 * to override any request. Other URLs answer `other(call)`.
 */
export const fakeEngineFetch = ({ entries = [], answer = () => null, other = () => json({}) } = {}) => {
  let next = entries.length + 1;
  const store = entries.map((entry) => ({ ...entry }));
  const impl = fakeFetch((call) => {
    const overridden = answer(call);
    if (overridden) return overridden;
    const { pathname } = new URL(call.url);
    const connect = pathname.match(/^\/api\/integration\/([^/]+)\/connect\/key$/);
    if (connect && call.method === 'POST') {
      const integrationID = decodeURIComponent(connect[1]);
      for (const entry of store) if (entry.integrationID === integrationID) entry.active = false;
      store.push({ id: `cred_${next}`, integrationID, label: `Key ${next}`, active: true, value: { type: 'key', key: call.body.key } });
      next += 1;
      return new Response(null, { status: 204 });
    }
    if (pathname === '/api/credential' && (call.method ?? 'GET') === 'GET') return json({ data: store });
    const one = pathname.match(/^\/api\/credential\/([^/]+)$/);
    if (one && call.method === 'DELETE') {
      const index = store.findIndex((entry) => entry.id === decodeURIComponent(one[1]));
      if (index === -1) return new Response(null, { status: 404 });
      store.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    return other(call);
  });
  impl.store = store;
  impl.connects = () => impl.calls.filter((call) => call.url.endsWith('/connect/key'));
  return impl;
};
