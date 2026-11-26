import { createHash } from 'node:crypto';
import nodeFs from 'node:fs';
import path from 'node:path';

import { writePrivateAtomic } from '../private-file.js';
import { isPlainObject, isText } from '../values.js';
import { pinAccount } from './account-guard.js';
import { MITTR_TOOLS, MittrToolError } from './registry.js';

const STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'];
const MAX_TODOS = 100;
const MAX_CONTENT = 4000;
const MAX_BYTES = 512 * 1024;
const ACCOUNT_KEY = /^[0-9a-f]{16}$/;
const SESSION_ID = /^[a-zA-Z0-9_-]{1,200}$/;
const TODO_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const refused = (message) => new MittrToolError(message, 400);

const todosOf = (value) => {
  if (!Array.isArray(value) || value.length > MAX_TODOS) throw refused(`todos must be a list of at most ${MAX_TODOS} items`);
  const ids = new Set();
  const todos = value.map((item) => {
    if (!isPlainObject(item) || Object.keys(item).some((key) => !['id', 'content', 'status'].includes(key))) throw refused('Each todo must contain only id, content and status');
    if (!isText(item.id) || !TODO_ID.test(item.id) || ids.has(item.id)) throw refused('Todo ids must be unique, 1-128 letters, numbers, underscores or hyphens');
    if (!isText(item.content) || !item.content.trim() || item.content.length > MAX_CONTENT || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(item.content)) throw refused(`Todo content must be nonblank text of at most ${MAX_CONTENT} characters without control characters`);
    if (!STATUSES.includes(item.status)) throw refused('Todo status must be pending, in_progress, completed or cancelled');
    ids.add(item.id);
    return { id: item.id, content: item.content, status: item.status };
  });
  if (Buffer.byteLength(JSON.stringify(todos)) > MAX_BYTES) throw refused('The checklist is too large');
  return todos;
};

// Synchronous per-conversation reads and atomic replacements have no await gap or
// shared account index: concurrent calls cannot interleave a partial snapshot.
export function createTodoStore({ dataDir, fs = nodeFs }) {
  const fileOf = (accountKey, sessionId) => {
    if (!isText(accountKey) || !ACCOUNT_KEY.test(accountKey) || !isText(sessionId) || !SESSION_ID.test(sessionId)) throw refused('A checklist needs a valid account and calling session');
    const sessionKey = createHash('sha256').update(sessionId).digest('hex');
    return path.join(dataDir, 'chat-checklists', accountKey, `${sessionKey}.json`);
  };
  const read = (accountKey, sessionId) => {
    const file = fileOf(accountKey, sessionId);
    try {
      const raw = fs.readFileSync(file, 'utf8');
      if (Buffer.byteLength(raw) > MAX_BYTES + 1024) throw new Error('oversize');
      const stored = JSON.parse(raw);
      if (!isPlainObject(stored) || stored.version !== 1) throw new Error('invalid version');
      return { todos: todosOf(stored.todos) };
    } catch (error) {
      if (error?.code === 'ENOENT') return { todos: [] };
      throw new MittrToolError('The conversation checklist cannot be read; its saved data was left unchanged', 500);
    }
  };
  return {
    read,
    write(accountKey, sessionId, input) {
      const todos = todosOf(input);
      const file = fileOf(accountKey, sessionId);
      read(accountKey, sessionId);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      try {
        writePrivateAtomic(file, `${JSON.stringify({ version: 1, todos })}\n`, { fs });
      } catch {
        throw new MittrToolError('The conversation checklist could not be saved', 500);
      }
      return { todos };
    },
    remove(accountKey, sessionId) {
      fs.rmSync(fileOf(accountKey, sessionId), { force: true });
    },
  };
}

export function registerTodoActions(registry, { store, activeAccountKey, engineOnActiveHome }) {
  registry.defineTool({
    name: MITTR_TOOLS.todo,
    description: 'Keep a checklist for multi-step work in this conversation. Read it with todo.read. Use todo.write to replace the whole list, keeping stable ids and updating pending, in_progress, completed or cancelled states as work changes. A checklist records your plan and progress; writing it does not execute any action or prove work ran. Mark work completed only after checking the result. Each successful result contains the full saved snapshot.',
    parameters: {
      todos: {
        type: 'array', maxItems: MAX_TODOS, description: 'The complete replacement checklist for todo.write; an empty list clears it',
        items: {
          type: 'object', additionalProperties: false, required: ['id', 'content', 'status'],
          properties: {
            id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,128}$', description: 'Stable unique item id' },
            content: { type: 'string', minLength: 1, maxLength: MAX_CONTENT, description: 'The work to do' },
            status: { type: 'string', enum: STATUSES },
          },
        },
      },
    },
  });
  for (const action of ['todo.read', 'todo.write']) {
    registry.register({
      action, tool: MITTR_TOOLS.todo, surfaces: ['agent'],
      title: action === 'todo.read' ? 'Read the checklist' : 'Update the checklist',
      description: action === 'todo.read' ? 'Read this conversation\'s full checklist' : 'Replace this conversation\'s full checklist and return the saved snapshot',
      effect: action === 'todo.read' ? 'read' : 'change',
      execute(input, ctx) {
        if (!activeAccountKey()) throw new MittrToolError('Sign in to Mittr to keep a conversation checklist', 401);
        const ensureSameAccount = pinAccount({ activeAccountKey, engineOnActiveHome });
        if (ctx.via !== 'engine' || !ctx.accountKey || !ctx.sessionId) throw refused('A checklist needs the calling engine account and session');
        ensureSameAccount(ctx.accountKey);
        ctx.signal?.throwIfAborted();
        const allowed = action === 'todo.write' ? ['action', 'todos'] : ['action'];
        if (!isPlainObject(input) || Object.keys(input).some((key) => !allowed.includes(key))) throw refused('Only checklist fields are accepted; account and session come from the calling context');
        return action === 'todo.read' ? store.read(ctx.accountKey, ctx.sessionId) : store.write(ctx.accountKey, ctx.sessionId, input.todos);
      },
    });
  }
}
