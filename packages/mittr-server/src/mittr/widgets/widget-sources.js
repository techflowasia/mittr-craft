import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import vm from 'node:vm';

import { isLoopbackOrUnspecified, lookupAll, normalizedHost, ownAddressCheck } from '../tools/chrome-service.js';
import { isRecord, isText } from '../values.js';

export const COMMAND_TIMEOUT_MS = 20_000;
export const URL_TIMEOUT_MS = 20_000;
export const OUTPUT_MAX_BYTES = 64 * 1024;
export const LIST_MAX_LINES = 5;

const SHELL = '/bin/sh';
const COMMAND_ENV = Object.freeze(['PATH', 'HOME', 'LANG']);
const MAX_REDIRECTS = 3;
const PATTERN_TIMEOUT_MS = 100;
const VALUE_MAX_CHARS = 200;
const STDERR_MAX_CHARS = 200;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const STATUSES = Object.freeze(['ok', 'warn', 'fail']);
const REQUEST_HEADERS = Object.freeze({ accept: 'application/json, text/plain;q=0.9, */*;q=0.5', 'user-agent': 'MittrCraft-Widget' });

const REFUSED_RANGES = (() => {
  const list = new net.BlockList();
  for (const [prefix, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) {
    list.addSubnet(prefix, bits, 'ipv4');
  }
  for (const [prefix, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]]) {
    list.addSubnet(prefix, bits, 'ipv6');
  }
  return list;
})();

export const isRefusedAddress = (address) => {
  const host = normalizedHost(address);
  if (isLoopbackOrUnspecified(host)) return true;
  if (net.isIPv4(host)) return REFUSED_RANGES.check(host, 'ipv4');
  if (net.isIPv6(host)) return REFUSED_RANGES.check(host, 'ipv6');
  return false;
};

const notFetched = (what) => new Error(`${what} is on this Mac or a private network, so it is not fetched`);

export const commandEnv = (env) => Object.fromEntries(COMMAND_ENV.filter((name) => isText(env?.[name]) && env[name]).map((name) => [name, env[name]]));

const isDirectory = (dir) => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

const killGroup = (child) => {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      return;
    }
  }
};

const firstLine = (text) => text.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, STDERR_MAX_CHARS) ?? '';

export const runCommand = ({ command, cwd }, { env = process.env, signal, timeoutMs = COMMAND_TIMEOUT_MS, maxBytes = OUTPUT_MAX_BYTES } = {}) => new Promise((resolve, reject) => {
  if (!isDirectory(cwd)) {
    reject(new Error(`The folder ${cwd} is not there`));
    return;
  }
  if (signal?.aborted) {
    reject(new Error('The command was stopped'));
    return;
  }
  const child = spawn(SHELL, ['-c', command], { cwd, env: commandEnv(env), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  let outBytes = 0;
  let truncated = false;
  let stderr = '';
  let ended = null;

  const end = (reason) => {
    if (ended) return;
    ended = reason;
    killGroup(child);
  };
  const timer = setTimeout(() => end('timeout'), timeoutMs);
  const onAbort = () => end('aborted');
  signal?.addEventListener('abort', onAbort, { once: true });

  child.stdout.on('data', (chunk) => {
    if (truncated) return;
    const room = maxBytes - outBytes;
    if (chunk.length > room) {
      out.push(chunk.subarray(0, room));
      outBytes = maxBytes;
      truncated = true;
      end('truncated');
      return;
    }
    out.push(chunk);
    outBytes += chunk.length;
  });
  child.stderr.on('data', (chunk) => {
    if (stderr.length < STDERR_MAX_CHARS * 4) stderr += chunk.toString('utf8');
  });

  const finish = (code) => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (ended === 'timeout') return reject(new Error(`The command took longer than ${Math.round(timeoutMs / 1000)} s`));
    if (ended === 'aborted') return reject(new Error('The command was stopped'));
    const text = Buffer.concat(out).toString('utf8');
    if (truncated || code === 0) return resolve({ text, truncated });
    const said = firstLine(stderr);
    return reject(new Error(`The command ended with code ${code}${said ? `: ${said}` : ''}`));
  };
  child.on('error', (error) => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    reject(new Error(`The command could not start: ${error.code ?? error.name}`));
  });
  child.on('close', (code) => finish(code));
});

const pageOf = (url) => {
  let page;
  try {
    page = new URL(url);
  } catch {
    throw new Error('The widget address is not a full http(s) address');
  }
  if (page.protocol !== 'http:' && page.protocol !== 'https:') throw new Error('Only http(s) addresses can be fetched');
  if (page.username || page.password) throw new Error('A widget address cannot carry a sign-in');
  return page;
};

const fencedLookup = (lookup, refused) => (hostname, options, callback) => {
  Promise.resolve()
    .then(() => lookup(hostname))
    .then((addresses) => {
      const usable = Array.isArray(addresses) ? addresses.filter((entry) => isText(entry?.address)) : [];
      if (usable.length === 0) throw new Error(`${hostname} could not be found, so it is not fetched`);
      if (usable.some((entry) => refused(entry.address))) throw notFetched(hostname);
      const family = (entry) => entry.family === 6 || entry.family === 'IPv6' ? 6 : 4;
      if (options?.all) return callback(null, usable.map((entry) => ({ address: entry.address, family: family(entry) })));
      return callback(null, usable[0].address, family(usable[0]));
    })
    .catch((error) => callback(error));
};

const getOnce = (page, { lookup, signal, timeoutMs, maxBytes }) => new Promise((resolve, reject) => {
  const transport = page.protocol === 'https:' ? https : http;
  let settled = false;
  const settle = (work) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    work();
  };
  const request = transport.request(page, { method: 'GET', headers: { ...REQUEST_HEADERS }, lookup, agent: false, signal }, (response) => {
    const status = response.statusCode ?? 0;
    if (REDIRECTS.has(status) && response.headers.location) {
      response.resume();
      settle(() => resolve({ redirect: new URL(response.headers.location, page).toString() }));
      return;
    }
    if (status < 200 || status > 299) {
      response.resume();
      settle(() => reject(new Error(`The address answered ${status}`)));
      return;
    }
    const parts = [];
    let bytes = 0;
    let truncated = false;
    response.on('data', (chunk) => {
      if (truncated) return;
      const room = maxBytes - bytes;
      if (chunk.length >= room) {
        parts.push(chunk.subarray(0, room));
        bytes = maxBytes;
        truncated = true;
        settle(() => resolve({ text: Buffer.concat(parts).toString('utf8'), truncated }));
        response.destroy();
        return;
      }
      parts.push(chunk);
      bytes += chunk.length;
    });
    response.on('end', () => settle(() => resolve({ text: Buffer.concat(parts).toString('utf8'), truncated })));
    response.on('error', (error) => settle(() => reject(error)));
  });
  const timer = setTimeout(() => {
    settle(() => reject(new Error(`The address took longer than ${Math.round(timeoutMs / 1000)} s`)));
    request.destroy();
  }, timeoutMs);
  request.on('error', (error) => settle(() => reject(signal?.aborted ? new Error('The fetch was stopped') : error)));
  request.end();
});

export const createUrlSource = ({ ownPorts = () => [], lookup = lookupAll, refused = isRefusedAddress, timeoutMs = URL_TIMEOUT_MS, maxBytes = OUTPUT_MAX_BYTES } = {}) => {
  const isOwnAddress = ownAddressCheck({ ownPorts, lookup });
  const pinned = fencedLookup(lookup, refused);

  const fenced = async (page) => {
    const host = normalizedHost(page.hostname);
    if (await isOwnAddress(page)) throw notFetched(page.host);
    if ((net.isIP(host) || isLoopbackOrUnspecified(host)) && refused(host)) throw notFetched(page.host);
    return page;
  };

  return async ({ url }, { signal } = {}) => {
    let page = await fenced(pageOf(url));
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const answer = await getOnce(page, { lookup: pinned, signal, timeoutMs, maxBytes });
      if (!answer.redirect) return answer;
      page = await fenced(pageOf(answer.redirect));
    }
    throw new Error(`The address redirected more than ${MAX_REDIRECTS} times`);
  };
};

const PATH_PART = /^(?:\.([A-Za-z_$][\w$-]*)|\[(\d+)\]|\["([^"\\]+)"\])/;
const FIRST_PART = /^([A-Za-z_$][\w$-]*)/;

export const jsonPathParts = (path) => {
  if (!isText(path)) return null;
  let rest = path.trim();
  if (rest.startsWith('$')) rest = rest.slice(1);
  const parts = [];
  const first = FIRST_PART.exec(rest);
  if (first) {
    parts.push(first[1]);
    rest = rest.slice(first[0].length);
  }
  while (rest) {
    const match = PATH_PART.exec(rest);
    if (!match) return null;
    parts.push(match[2] === undefined ? (match[1] ?? match[3]) : Number(match[2]));
    rest = rest.slice(match[0].length);
  }
  return parts;
};

const atPath = (data, path) => {
  let value = data;
  for (const part of jsonPathParts(path) ?? []) {
    if (!(isRecord(value) || Array.isArray(value)) || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
};

const matchOf = (text, pattern, group) => vm.runInNewContext(
  'const found = new RegExp(pattern).exec(text); found === null ? null : String(found[found[group] === undefined ? 0 : group]);',
  { pattern, text, group },
  { timeout: PATTERN_TIMEOUT_MS },
);

const clipped = (value) => String(value).slice(0, VALUE_MAX_CHARS);

const asLine = (item) => clipped(isRecord(item) || Array.isArray(item) ? JSON.stringify(item) : item);

const shown = (raw, extract, display) => {
  if (display === 'number') {
    const number = Number.isFinite(raw) ? raw : Number(String(raw).replace(/[,\s]/g, ''));
    return Number.isFinite(number) && String(raw).trim() !== '' ? { value: number } : { error: `The value is not a number: ${clipped(raw).slice(0, 40)}` };
  }
  if (display === 'status') {
    const text = String(raw).trim().toLowerCase();
    const mapped = isRecord(extract.status)
      ? STATUSES.find((status) => (extract.status[status] ?? []).some((word) => String(word).trim().toLowerCase() === text))
      : undefined;
    const status = mapped ?? STATUSES.find((name) => name === text);
    return status ? { value: status } : { error: `The value is not a status: ${clipped(raw).slice(0, 40)}` };
  }
  const lines = Array.isArray(raw) ? raw.map(asLine) : String(raw).split('\n').map((line) => line.trim()).filter(Boolean).map(clipped);
  return { value: lines.slice(0, LIST_MAX_LINES) };
};

export const extractValue = (text, extract = {}, display) => {
  let raw = String(text ?? '');
  if (isText(extract.json)) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return { error: 'The answer is not JSON' };
    }
    raw = atPath(data, extract.json);
    if (raw === undefined || raw === null) return { error: `Nothing at ${extract.json}` };
  } else if (isText(extract.regex)) {
    let found;
    try {
      found = matchOf(raw, extract.regex, Number.isInteger(extract.group) ? extract.group : 1);
    } catch (error) {
      return { error: error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? 'The pattern took too long' : 'The pattern could not run' };
    }
    if (found === null) return { error: 'The pattern found nothing' };
    raw = found;
  } else {
    raw = raw.trim();
  }
  return shown(raw, extract, display);
};
