#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`;

const FORM = page('Stub form', `<h1>Stub form</h1>
<form action="/thanks" method="get">
<label>Name <input name="name" aria-label="Name"></label>
<label>Email <input name="email" type="email" aria-label="Email"></label>
<label>Plan <select name="plan" aria-label="Plan"><option value="basic">Basic</option><option value="pro">Pro</option></select></label>
<button type="submit">Submit</button>
</form>
<div style="height:2400px"></div>
<footer id="footer">Footer of the stub form</footer>`);

const ERROR = page('Stub error', `<h1>Stub error page</h1><p>This page logs one console error.</p>
<script>console.error('stub page error: widget failed to load')</script>`);

const LANDING = page('Stub landing', '<h1>Stub landing</h1><p>landing-marker: the page behind the redirect</p>');

const SIGN_IN = page('Stub sign in', `<h1>Sign in to the stub</h1>
<form action="/signed-in" method="post">
<label>Username <input name="username" aria-label="Username"></label>
<label>Password <input name="password" type="password" aria-label="Password"></label>
<button type="submit">Sign in</button>
</form>`);

const STYLE = page('Stub style', `<h1 style="font-size: 32px; margin: 16px">Style check</h1>
<button id="go" style="background-color: #0a7; color: #fff; padding: 8px 16px">Go</button>`);

const thanks = (query) => page('Thanks', `<h1>Thanks, ${escapeHtml(query.get('name'))}</h1>
<p>Email: ${escapeHtml(query.get('email'))}</p><p>Plan: ${escapeHtml(query.get('plan'))}</p>`);

const hostnameOf = (host) => String(host ?? '').replace(/:\d+$/, '').toLowerCase();

export function createStubPages({ log = () => {} } = {}) {
  const seen = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const host = String(req.headers.host ?? '');
    seen.push({ at: Date.now(), host, path: url.pathname });
    log(`${new Date().toISOString()} ${req.method} ${host} ${url.pathname}`);
    const html = (status, body) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    };
    if (url.pathname === '/form') return html(200, FORM);
    if (url.pathname === '/thanks') return html(200, thanks(url.searchParams));
    if (url.pathname === '/error') return html(200, ERROR);
    if (url.pathname === '/landing') return html(200, LANDING);
    if (url.pathname === '/sign-in') return html(200, SIGN_IN);
    if (url.pathname === '/style') return html(200, STYLE);
    if (url.pathname === '/redirect') {
      const port = server.address().port;
      const target = hostnameOf(host) === 'localhost' ? `http://127.0.0.1:${port}/landing` : '/landing';
      res.writeHead(302, { location: target, 'cache-control': 'no-store' });
      return res.end();
    }
    return html(404, page('Not found', '<p>Not found</p>'));
  });

  return {
    server,
    requests: () => seen.slice(),
    listen: (port = 0) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve(server.address().port));
    }),
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

const main = async () => {
  const argv = process.argv.slice(2);
  const portAt = argv.indexOf('--port');
  const logAt = argv.indexOf('--log');
  const logFile = logAt === -1 ? null : argv[logAt + 1];
  const fs = await import('node:fs');
  const pages = createStubPages({ log: (line) => { if (logFile) fs.appendFileSync(logFile, `${line}\n`); } });
  const bound = await pages.listen(portAt === -1 ? 0 : Number(argv[portAt + 1]));
  process.stdout.write(`stub pages listening on 127.0.0.1:${bound}\n`);
  const stop = () => pages.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
