import fs from 'fs';
import path from 'path';

const FILE_READ_LIMIT = 5 * 1024 * 1024;
const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]}|]+/g;

export const SCRIPT_CHECKS = new Set(['file', 'command', 'sources']);

const squash = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');

const missing = (reason) => ({ status: 'missing', reason });
const met = (reason) => ({ status: 'met', reason });

const resolveInside = async (directory, relativePath, fsImpl) => {
  if (!directory) return { error: 'the session has no workspace directory' };
  const root = await fsImpl.promises.realpath(directory).catch(() => null);
  if (!root) return { error: 'the workspace directory cannot be read' };
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    return { error: `${relativePath} is outside the workspace` };
  }
  const real = await fsImpl.promises.realpath(target).catch(() => null);
  if (!real) return { error: `${relativePath} does not exist` };
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
    return { error: `${relativePath} points outside the workspace` };
  }
  return { file: real };
};

const readWorkspaceFile = async (directory, relativePath, fsImpl) => {
  const resolved = await resolveInside(directory, relativePath, fsImpl);
  if (resolved.error) return resolved;
  const stat = await fsImpl.promises.stat(resolved.file).catch(() => null);
  if (!stat || !stat.isFile()) return { error: `${relativePath} is not a file` };
  if (stat.size === 0) return { error: `${relativePath} is empty` };
  const handle = await fsImpl.promises.open(resolved.file, 'r');
  try {
    const length = Math.min(stat.size, FILE_READ_LIMIT);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return { content: buffer.toString('utf8') };
  } finally {
    await handle.close();
  }
};

const checkFile = async (check, { directory, fsImpl }) => {
  const read = await readWorkspaceFile(directory, check.path, fsImpl);
  if (read.error) return missing(read.error);
  if (check.contains && !read.content.includes(check.contains)) {
    return missing(`${check.path} does not contain "${check.contains}"`);
  }
  return met(check.contains ? `${check.path} exists and contains "${check.contains}"` : `${check.path} exists`);
};

const REDIRECTION = /\s*\d*>>?&?\s*(?:\d+|\/dev\/null|[^\s;|&]+)/g;
const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;

const decidesExit = (command, wanted) => {
  const segments = command.replace(REDIRECTION, ' ').split(/\|\||;|\||(?<!&)&(?!&)|\n/);
  const last = segments[segments.length - 1] ?? '';
  return last.split('&&').some((part) => {
    const simple = squash(part).replace(ENV_PREFIX, '');
    return simple === wanted || simple.startsWith(`${wanted} `);
  });
};

const checkCommand = (check, { evidence }) => {
  const wanted = squash(check.command);
  const entries = evidence.entries;
  let run = null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.tool === 'bash' && squash(entry.command).includes(wanted)) {
      run = entry;
      break;
    }
  }
  if (!run) return missing(`\`${check.command}\` has not been run in this goal`);
  if (!decidesExit(run.command, wanted)) {
    return missing(`the recorded exit code of the last run of \`${check.command}\` belongs to another command on the same line; run \`${check.command}\` on its own`);
  }
  if (run.status !== 'completed') return missing(`the last run of \`${check.command}\` did not complete (${run.status})`);
  if (run.exit === null) return missing(`the last run of \`${check.command}\` recorded no exit code`);
  if (run.exit !== 0) return missing(`the last run of \`${check.command}\` exited with ${run.exit}`);
  const editedAfter = entries.some((entry) => entry.index > run.index && entry.edit && entry.status === 'completed');
  if (editedAfter) return missing(`files were changed after the last passing run of \`${check.command}\`; run it again`);
  return met(`\`${check.command}\` exited 0 after the last change (tool call #${run.index + 1})`);
};

const normalizeUrl = (raw) => {
  const trimmed = String(raw).replace(/[.,;:!?*_]+$/, '');
  try {
    const url = new URL(trimmed);
    url.hash = '';
    const value = url.toString();
    return value.endsWith('/') ? value.slice(0, -1) : value;
  } catch {
    return null;
  }
};

const urlsIn = (content) => {
  const found = new Set();
  for (const match of String(content ?? '').matchAll(URL_PATTERN)) {
    const url = normalizeUrl(match[0]);
    if (url) found.add(url);
  }
  return found;
};

const checkSources = async (check, { directory, evidence, fsImpl }) => {
  let cited;
  let where;
  if (check.path) {
    const read = await readWorkspaceFile(directory, check.path, fsImpl);
    if (read.error) return missing(read.error);
    cited = urlsIn(read.content);
    where = check.path;
  } else {
    cited = urlsIn(evidence.report);
    where = 'the final report';
  }
  if (cited.size === 0) return missing(`${where} cites no sources`);
  const opened = urlsIn(evidence.corpus);
  const unopened = [...cited].filter((url) => !opened.has(url) && !evidence.corpus.includes(url));
  if (unopened.length > 0) {
    return missing(`${where} cites sources that were never opened or returned by a search in this goal: ${unopened.slice(0, 5).join(', ')}`);
  }
  return met(`all ${cited.size} sources cited in ${where} were opened or returned by a search`);
};

export const runScriptCheck = async (criterion, { directory, evidence, fsImpl = fs }) => {
  const check = criterion.check;
  try {
    if (check.type === 'file') return await checkFile(check, { directory, fsImpl });
    if (check.type === 'command') return checkCommand(check, { evidence });
    if (check.type === 'sources') return await checkSources(check, { directory, evidence, fsImpl });
  } catch (error) {
    return missing(`the check could not run: ${error?.message || error}`);
  }
  return null;
};
