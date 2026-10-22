import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HASHED_MAX_BYTES = 4 * 1024 * 1024;
const SYSTEM_PREFIXES = Object.freeze(['/bin/', '/sbin/', '/usr/', '/System/', '/Library/', '/opt/homebrew/']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx', 'bunx', 'pnpx']);
const INTERPRETERS = new Set(['node', 'python', 'python3', 'bash', 'sh', 'zsh', 'dash', 'ruby', 'perl', 'php', 'deno', 'bun', 'tsx', 'ts-node', 'osascript', 'source', '.']);
const WRAPPERS = new Set(['env', 'exec', 'command', 'time', 'nice', 'nohup', 'caffeinate']);
const SUBCOMMANDS = new Set(['run', 'exec']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const INLINE_LONG_FLAGS = new Set(['--eval', '--print', '--require', '--import', '--command']);
const INLINE_SHORT_FLAG = /^-[A-Za-z]*[cemprE]/;
const MAKEFILES = Object.freeze(['Makefile', 'makefile', 'GNUmakefile']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SEPARATORS = new Set([';', '&', '|', '(', ')', '`', '\n', '{', '}']);

const split = (command) => {
  const segments = [[]];
  let token = null;
  let quote = null;
  const push = () => {
    if (token !== null) segments.at(-1).push(token);
    token = null;
  };
  for (let at = 0; at < command.length; at += 1) {
    const char = command[at];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && at + 1 < command.length) token += command[++at];
      else token += char;
      continue;
    }
    if (char === '"' || char === '\'') {
      quote = char;
      token ??= '';
      continue;
    }
    if (char === '\\' && at + 1 < command.length) {
      token = (token ?? '') + command[++at];
      continue;
    }
    if (char === '$' && command[at + 1] === '(') {
      push();
      segments.push([]);
      at += 1;
      continue;
    }
    if (SEPARATORS.has(char)) {
      push();
      segments.push([]);
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    token = (token ?? '') + char;
  }
  push();
  return segments.filter((segment) => segment.length > 0);
};

const expanded = (token) => (token === '~' || token.startsWith('~/') ? path.join(os.homedir(), token.slice(1)) : token);

const gitConfigOf = (cwd) => {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    const marker = path.join(dir, '.git');
    let stat = null;
    try {
      stat = fs.statSync(marker);
    } catch {
      stat = null;
    }
    if (stat) return stat.isDirectory() ? path.join(marker, 'config') : marker;
    if (path.dirname(dir) === dir) return null;
  }
};

const isSystem = (file) => SYSTEM_PREFIXES.some((prefix) => file.startsWith(prefix));

const filesOfSegment = (tokens, cwd, depth) => {
  let at = 0;
  while (at < tokens.length && (ASSIGNMENT.test(tokens[at]) || WRAPPERS.has(tokens[at]))) at += 1;
  const head = tokens[at];
  if (head === undefined) return [];
  const files = [];
  const named = (token) => {
    const file = path.resolve(cwd, expanded(token));
    if (!isSystem(file)) files.push(file);
  };
  if (head.includes('/')) named(head);
  const name = path.basename(head);
  if (PACKAGE_MANAGERS.has(name)) named('package.json');
  if (name === 'make') for (const file of MAKEFILES) named(file);
  if (name === 'git') {
    const config = gitConfigOf(cwd);
    if (config) named(config);
  }
  if (INTERPRETERS.has(name)) {
    for (let next = at + 1; next < tokens.length; next += 1) {
      const token = tokens[next];
      if (SHELLS.has(name) && /^-[A-Za-z]*c/.test(token)) {
        if (depth < 3 && tokens[next + 1] !== undefined) files.push(...filesOf(tokens[next + 1], cwd, depth + 1));
        break;
      }
      if (INLINE_LONG_FLAGS.has(token) || (!SHELLS.has(name) && !token.startsWith('--') && INLINE_SHORT_FLAG.test(token))) break;
      if (token.startsWith('-') || (next === at + 1 && SUBCOMMANDS.has(token))) continue;
      named(token);
      break;
    }
  }
  return files;
};

const filesOf = (command, cwd, depth) => {
  let dir = cwd;
  return split(command).flatMap((tokens) => {
    if (tokens[0] === 'cd' || tokens[0] === 'pushd') {
      dir = tokens[1] === undefined ? os.homedir() : path.resolve(dir, expanded(tokens[1]));
      return [];
    }
    return filesOfSegment(tokens, dir, depth);
  });
};

export const commandFiles = (command, cwd) => {
  if (typeof command !== 'string' || typeof cwd !== 'string') return [];
  return [...new Set(filesOf(command, cwd, 0))].sort();
};

export const fileFingerprint = (file) => {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return 'directory';
  if (!stat.isFile()) return `other:${stat.ino}`;
  if (stat.size > HASHED_MAX_BYTES) return `large:${stat.size}:${stat.mtimeMs}:${stat.ino}`;
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return 'unreadable';
  }
};

export const fingerprintsOf = (files) => Object.fromEntries(files.map((file) => [file, fileFingerprint(file)]));

export const sourceFiles = (source) => (source?.type === 'command' ? commandFiles(source.command, source.cwd) : []);

export const filesUnchanged = (approved, files) => {
  if (!approved || typeof approved !== 'object') return files.length === 0;
  const names = Object.keys(approved).sort();
  if (names.length !== files.length || names.some((name, at) => name !== files[at])) return false;
  return names.every((name) => fileFingerprint(name) === approved[name]);
};

export const isDirectory = (dir) => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
};
