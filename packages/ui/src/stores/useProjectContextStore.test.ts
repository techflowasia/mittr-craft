import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ProjectTodoChange } from '@/lib/projectContextApi';

interface NotePayload {
  id: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  source: 'manual' | 'selection' | 'agent';
  pinned: boolean;
  planId?: string;
}

interface ContextPayload {
  notes: NotePayload[];
  todos: { id: string; text: string; completed: boolean; createdAt: number; planId?: string; dependsOn?: string[] }[];
  plans: { id: string; file: string; title: string; createdAt: number; pinned: boolean }[];
  notesTodosStore?: 'local' | 'repository';
}

const emptyPayload = (): ContextPayload => ({ notes: [], todos: [], plans: [] });

const note = (overrides: Partial<NotePayload> = {}): NotePayload => ({
  id: 'n1',
  body: 'body',
  createdAt: 1,
  updatedAt: 1,
  source: 'manual',
  pinned: false,
  ...overrides,
});

const planLink = (overrides: Partial<ContextPayload['plans'][number]> = {}) => ({
  id: 'p1',
  file: 'a.md',
  title: 'A',
  createdAt: 1,
  pinned: false,
  ...overrides,
});

// The UI tsconfig does not load bun's test globals, so these tests follow the
// local precedent of swapping plain handlers instead of using mock helpers.
const handlers = {
  fetch: async (): Promise<ContextPayload> => emptyPayload(),
  saveTodos: async (todos: ContextPayload['todos']): Promise<ContextPayload> => ({
    notes: [],
    todos,
    plans: [],
  }),
  createNote: async (): Promise<{ note: NotePayload; context: ContextPayload }> => ({
    note: note(),
    context: { notes: [note()], todos: [], plans: [] },
  }),
  updateNote: async (): Promise<NotePayload | null> => note(),
  deleteNote: async (): Promise<ContextPayload> => emptyPayload(),
  writeTodo: async (_change: ProjectTodoChange): Promise<ContextPayload | null> => emptyPayload(),
  create: async (): Promise<{ plan: ContextPayload['plans'][number]; context: ContextPayload }> => ({
    plan: planLink(),
    context: { notes: [], todos: [], plans: [planLink()] },
  }),
  update: async (): Promise<{ plan: ContextPayload['plans'][number]; raw: string } | null> => ({
    plan: planLink(),
    raw: '# A',
  }),
  pinPlan: async (): Promise<ContextPayload['plans'][number] | null> => planLink({ pinned: true }),
  remove: async (): Promise<ContextPayload> => emptyPayload(),
};

const savedStores: (string | null)[] = [];
const calls = { fetch: 0, saveTodos: 0, writeTodo: 0, createNote: 0, updateNote: 0, deleteNote: 0, create: 0, update: 0, pinPlan: 0, remove: 0 };

mock.module('@/lib/projectContextApi', () => ({
  fetchProjectContext: () => {
    calls.fetch += 1;
    return handlers.fetch();
  },
  saveProjectTodos: (_project: unknown, todos: ContextPayload['todos'], todosStore: string | null) => {
    calls.saveTodos += 1;
    savedStores.push(todosStore);
    return handlers.saveTodos(todos);
  },
  writeProjectTodo: (_project: { path?: string }, change: ProjectTodoChange) => {
    calls.writeTodo += 1;
    return handlers.writeTodo(change);
  },
  createProjectNote: () => {
    calls.createNote += 1;
    return handlers.createNote();
  },
  updateProjectNote: () => {
    calls.updateNote += 1;
    return handlers.updateNote();
  },
  deleteProjectNote: () => {
    calls.deleteNote += 1;
    return handlers.deleteNote();
  },
  linkProjectPlanSession: async () => null,
  shareProjectPlan: async () => null,
  unshareProjectPlan: async () => null,
  setProjectPlanPinned: () => {
    calls.pinPlan += 1;
    return handlers.pinPlan();
  },
  createProjectPlan: () => {
    calls.create += 1;
    return handlers.create();
  },
  updateProjectPlan: () => {
    calls.update += 1;
    return handlers.update();
  },
  deleteProjectPlan: () => {
    calls.remove += 1;
    return handlers.remove();
  },
  resolveProjectContextId: (project: { path?: string } | null | undefined) => (
    project?.path ? `path_${project.path}` : ''
  ),
}));

const { useProjectContextStore } = await import('./useProjectContextStore');

const PROJECT = { id: 'ignored', path: '/repo' };
const store = () => useProjectContextStore.getState();
const entry = () => store().getEntry(PROJECT);

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const failWith = (message: string) => async (): Promise<never> => {
  throw new Error(message);
};

beforeEach(() => {
  store().reset();
  savedStores.length = 0;
  calls.fetch = 0;
  calls.saveTodos = 0;
  calls.writeTodo = 0;
  calls.createNote = 0;
  calls.updateNote = 0;
  calls.deleteNote = 0;
  calls.create = 0;
  calls.update = 0;
  calls.pinPlan = 0;
  calls.remove = 0;

  handlers.fetch = async () => emptyPayload();
  handlers.saveTodos = async (todos) => ({ notes: [], todos, plans: [] });
  handlers.createNote = async () => ({ note: note(), context: { notes: [note()], todos: [], plans: [] } });
  handlers.updateNote = async () => note();
  handlers.deleteNote = async () => emptyPayload();
  handlers.writeTodo = async () => emptyPayload();
  handlers.create = async () => ({ plan: planLink(), context: { notes: [], todos: [], plans: [planLink()] } });
  handlers.update = async () => ({ plan: planLink(), raw: '# A' });
  handlers.pinPlan = async () => planLink({ pinned: true });
  handlers.remove = async () => emptyPayload();
});

describe('getEntry', () => {
  test('returns a stable empty entry for an unknown project', () => {
    expect(entry()).toEqual({ notes: [], todos: [], plans: [], sharedPlansDir: null, notesTodosStore: null, loaded: false, loading: false, error: null });
  });

  test('returns the empty entry for a project without a path', () => {
    expect(store().getEntry({ id: 'x', path: '' }).loaded).toBe(false);
  });
});

describe('load', () => {
  test('populates from the server', async () => {
    handlers.fetch = async () => ({
      notes: [note({ body: 'server note' })],
      todos: [{ id: 't1', text: 'a', completed: false, createdAt: 1 }],
      plans: [planLink()],
    });

    await store().load(PROJECT);

    expect(entry().notes.map((entryNote) => entryNote.body)).toEqual(['server note']);
    expect(entry().todos).toHaveLength(1);
    expect(entry().plans).toHaveLength(1);
    expect(entry().loaded).toBe(true);
    expect(entry().error).toBeNull();
  });

  test('does not refetch once loaded', async () => {
    await store().load(PROJECT);
    await store().load(PROJECT);
    expect(calls.fetch).toBe(1);
  });

  test('refetches when forced', async () => {
    await store().load(PROJECT);
    await store().load(PROJECT, { force: true });
    expect(calls.fetch).toBe(2);
  });

  test('a failed load preserves previously loaded data instead of clearing it', async () => {
    handlers.fetch = async () => ({ notes: [note({ body: 'kept' })], todos: [], plans: [] });
    await store().load(PROJECT);

    handlers.fetch = failWith('offline');
    await store().load(PROJECT, { force: true });

    expect(entry().notes.map((entryNote) => entryNote.body)).toEqual(['kept']);
    expect(entry().loaded).toBe(true);
    expect(entry().error).toBe('offline');
  });

  test('a first-load failure reports the error and stays unloaded', async () => {
    handlers.fetch = failWith('boom');

    await store().load(PROJECT);

    expect(entry().loaded).toBe(false);
    expect(entry().notes).toEqual([]);
    expect(entry().error).toBe('boom');
  });

  test('concurrent loads issue a single request', async () => {
    await Promise.all([store().load(PROJECT), store().load(PROJECT), store().load(PROJECT)]);
    expect(calls.fetch).toBe(1);
  });

  test('coalesces refreshes requested during a load into one authoritative trailing read', async () => {
    const gate = deferred<ContextPayload>();
    handlers.fetch = () => calls.fetch === 1
      ? gate.promise
      : Promise.resolve({ notes: [note({ body: 'peer change' })], todos: [], plans: [] });

    const initial = store().load(PROJECT);
    await Promise.resolve();
    const firstRefresh = store().load(PROJECT, { force: true });
    const secondRefresh = store().load(PROJECT, { force: true });
    gate.resolve(emptyPayload());
    await Promise.all([initial, firstRefresh, secondRefresh]);

    expect(entry().notes.map((item) => item.body)).toEqual(['peer change']);
    expect(calls.fetch).toBe(2);
  });

  test('a refresh cannot undo a local write that completed after the read began', async () => {
    handlers.fetch = async () => ({ notes: [note()], todos: [], plans: [] });
    await store().load(PROJECT);
    const gate = deferred<ContextPayload>();
    handlers.fetch = () => gate.promise;
    const refresh = store().load(PROJECT, { force: true });
    await Promise.resolve();
    handlers.updateNote = async () => note({ body: 'new local body', updatedAt: 2 });
    await store().saveNoteBody(PROJECT, 'n1', 'new local body');
    gate.resolve({ notes: [note()], todos: [], plans: [] });
    await refresh;

    expect(entry().notes[0].body).toBe('new local body');
  });

  test('a peer change during a local note save is read after that save settles', async () => {
    handlers.fetch = async () => ({ notes: [note()], todos: [], plans: [] });
    await store().load(PROJECT);
    const gate = deferred<NotePayload | null>();
    handlers.updateNote = () => gate.promise;
    const saving = store().saveNoteBody(PROJECT, 'n1', 'local edit');
    handlers.fetch = async () => ({
      notes: [note({ body: 'local edit' }), note({ id: 'peer', body: 'peer note' })],
      todos: [],
      plans: [],
    });
    const refresh = store().load(PROJECT, { force: true });
    await Promise.resolve();
    gate.resolve(note({ body: 'local edit' }));
    await Promise.all([saving, refresh]);

    expect(entry().notes.map((item) => item.body)).toEqual(['local edit', 'peer note']);
  });

  for (const failureOrder of ['before the read', 'after the read']) {
    test(`a local write failing ${failureOrder} cannot hide the peer snapshot`, async () => {
      handlers.fetch = async () => ({ notes: [note()], todos: [], plans: [] });
      await store().load(PROJECT);
      const reading = deferred<ContextPayload>();
      handlers.fetch = () => reading.promise;
      const refresh = store().load(PROJECT, { force: true });
      await Promise.resolve();
      const writing = deferred<NotePayload | null>();
      handlers.updateNote = () => writing.promise;
      const saving = store().saveNoteBody(PROJECT, 'n1', 'rejected local edit');
      await Promise.resolve();
      const peer = { notes: [note(), note({ id: 'peer', body: 'peer note' })], todos: [], plans: [] };
      handlers.fetch = async () => peer;
      if (failureOrder === 'after the read') {
        reading.resolve(peer);
        await Promise.resolve();
        await Promise.resolve();
      }
      writing.reject(new Error('save failed'));
      expect(await saving).toBe(false);
      if (failureOrder === 'before the read') reading.resolve(peer);
      await refresh;

      expect(entry().notes.map((item) => item.body)).toEqual(['body', 'peer note']);
    });
  }

  test('reset rejects an old runtime read even when the project id is reused', async () => {
    const gate = deferred<ContextPayload>();
    handlers.fetch = () => gate.promise;
    const obsolete = store().load(PROJECT);
    await Promise.resolve();
    store().reset();
    handlers.fetch = async () => ({ notes: [note({ body: 'new runtime' })], todos: [], plans: [] });
    await store().load(PROJECT);
    gate.resolve({ notes: [note({ body: 'old runtime' })], todos: [], plans: [] });
    await obsolete;

    expect(entry().notes[0].body).toBe('new runtime');
  });
});

describe('saveTodos', () => {
  test('a whole list names the store it was read from, and a refused one reloads the list', async () => {
    const todo = { id: 'a', text: 'A', completed: false, createdAt: 1 };
    handlers.fetch = async () => ({ notes: [], todos: [todo], plans: [], notesTodosStore: 'local' });
    await store().load(PROJECT);
    handlers.fetch = async () => ({ notes: [], todos: [{ ...todo, id: 'team' }, todo], plans: [], notesTodosStore: 'repository' });
    handlers.saveTodos = failWith('Notes and todos moved to another store; reload the list');

    expect(await store().saveTodos(PROJECT, [])).toBe(false);
    expect(savedStores).toEqual(['local']);
    await store().load(PROJECT);
    expect(entry().todos.map((entry) => entry.id)).toEqual(['team', 'a']);
    expect(entry().notesTodosStore).toBe('repository');
  });

  test('applies optimistically before the request resolves', async () => {
    const gate = deferred<ContextPayload>();
    handlers.saveTodos = () => gate.promise;

    const pending = store().saveTodos(PROJECT, [{ id: 't1', text: 'typed', completed: false, createdAt: 1 }]);
    expect(entry().todos).toHaveLength(1);

    gate.resolve({ notes: [], todos: [{ id: 't1', text: 'typed', completed: false, createdAt: 1 }], plans: [] });
    expect(await pending).toBe(true);
    expect(entry().todos).toHaveLength(1);
  });

  test('a refused clear-completed restores every todo with its plan links and reports the error', async () => {
    const done = { id: 'done', text: 'done', completed: true, createdAt: 1, planId: 'p1' };
    const next = { id: 'next', text: 'next', completed: false, createdAt: 2, planId: 'p1', dependsOn: ['done'] };
    await store().saveTodos(PROJECT, [next, done]);
    handlers.saveTodos = failWith('A dependency must link two todos of the same plan');

    expect(await store().saveTodos(PROJECT, [next])).toBe(false);
    expect(entry().todos).toEqual([next, done]);
    expect(entry().error).toBe('A dependency must link two todos of the same plan');
  });

  test('serializes concurrent writes in call order', async () => {
    const order: string[] = [];
    handlers.saveTodos = async (todos) => {
      const label = todos[0]?.text ?? 'empty';
      order.push(`start:${label}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end:${label}`);
      return { notes: [], todos, plans: [] };
    };

    await Promise.all([
      store().saveTodos(PROJECT, [{ id: '1', text: 'first', completed: false, createdAt: 1 }]),
      store().saveTodos(PROJECT, [{ id: '2', text: 'second', completed: false, createdAt: 2 }]),
    ]);

    expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  });

  test('a load resolving during an in-flight write does not clobber it', async () => {
    const gate = deferred<ContextPayload>();
    handlers.saveTodos = () => gate.promise;
    handlers.fetch = async () => ({
      notes: [note({ body: 'from server' })],
      todos: [{ id: 'stale', text: 'stale', completed: false, createdAt: 0 }],
      plans: [],
    });

    const pending = store().saveTodos(PROJECT, [{ id: 'local', text: 'local', completed: false, createdAt: 1 }]);
    await store().load(PROJECT);

    expect(entry().todos.map((todo) => todo.id)).toEqual(['local']);
    // The same snapshot still delivers the fields the write did not touch.
    expect(entry().notes.map((entryNote) => entryNote.body)).toEqual(['from server']);

    gate.resolve({ notes: [], todos: [{ id: 'local', text: 'local', completed: false, createdAt: 1 }], plans: [] });
    await pending;
  });

  test('older responses cannot undo rapid add, toggle, reorder, and delete', async () => {
    const a = { id: 'a', text: 'A', completed: false, createdAt: 1 };
    const b = { id: 'b', text: 'B', completed: false, createdAt: 2 };
    const snapshots = [[a], [a, b], [{ ...a, completed: true }, b], [b, { ...a, completed: true }], [b]];
    const gates = snapshots.map(() => deferred<ContextPayload>());
    const sent: ContextPayload['todos'][] = [];
    handlers.saveTodos = (todos) => {
      const index = sent.length;
      sent.push(todos);
      return gates[index].promise;
    };
    const saves = snapshots.map((todos) => store().saveTodos(PROJECT, todos));
    handlers.fetch = async () => ({ ...emptyPayload(), todos: [b] });
    let midLoad: Promise<void> = Promise.resolve();
    for (let index = 0; index < gates.length; index += 1) {
      gates[index].resolve({ ...emptyPayload(), todos: snapshots[index] });
      expect(await saves[index]).toBe(true);
      expect(entry().todos).toEqual([b]);
      if (index === 0) {
        midLoad = store().load(PROJECT, { force: true });
        expect(entry().todos).toEqual([b]);
      }
    }
    await midLoad;
    expect(sent).toEqual(snapshots);
    expect(entry().todos).toEqual([b]);
    await store().load(PROJECT, { force: true });
    expect(entry().todos).toEqual([b]);
  });

  test('failed older saves preserve newer edits and a later success clears the error', async () => {
    const first = deferred<ContextPayload>();
    const second = deferred<ContextPayload>();
    let count = 0;
    handlers.saveTodos = () => (++count === 1 ? first.promise : second.promise);
    const a = { id: 'a', text: 'A', completed: false, createdAt: 1 };
    const one = store().saveTodos(PROJECT, [a]);
    const two = store().saveTodos(PROJECT, [{ ...a, completed: true }]);
    first.reject(new Error('offline'));
    expect(await one).toBe(false);
    expect(entry().todos[0].completed).toBe(true);
    second.resolve({ ...emptyPayload(), todos: [{ ...a, completed: true }] });
    expect(await two).toBe(true);
    expect(entry().error).toBeNull();
  });

  test('a failed queue restores the last confirmed list, not an unsaved optimistic list', async () => {
    const a = { id: 'a', text: 'confirmed', completed: false, createdAt: 1 };
    await store().saveTodos(PROJECT, [a]);
    const gate = deferred<ContextPayload>();
    handlers.saveTodos = () => gate.promise;
    const one = store().saveTodos(PROJECT, []);
    const two = store().saveTodos(PROJECT, [{ ...a, text: 'unsaved' }]);
    gate.reject(new Error('disk full'));
    expect(await one).toBe(false);
    expect(await two).toBe(false);
    expect(entry().todos).toEqual([a]);
    expect(entry().error).toBe('disk full');
  });

  test('a later failure rolls back to an earlier queued success including server normalization', async () => {
    const first = deferred<ContextPayload>();
    const second = deferred<ContextPayload>();
    let count = 0;
    handlers.saveTodos = () => (++count === 1 ? first.promise : second.promise);
    const a = { id: 'a', text: 'normalized', completed: false, createdAt: 1 };
    const one = store().saveTodos(PROJECT, [{ ...a, text: ' normalized ' }]);
    const two = store().saveTodos(PROJECT, []);
    first.resolve({ ...emptyPayload(), todos: [a] });
    expect(await one).toBe(true);
    expect(entry().todos).toEqual([]);
    second.reject(new Error('read only'));
    expect(await two).toBe(false);
    expect(entry().todos).toEqual([a]);
    handlers.fetch = failWith('offline');
    await store().load(PROJECT, { force: true });
    expect(entry().todos).toEqual([a]);
    expect(entry().error).toBe('offline');
  });

  test('an unrelated project can save while this project is waiting', async () => {
    const gate = deferred<ContextPayload>();
    handlers.saveTodos = (todos) => todos.length === 0 ? gate.promise : Promise.resolve({ ...emptyPayload(), todos });
    const pending = store().saveTodos(PROJECT, []);
    const other = { id: 'other', path: '/other' };
    const todos = [{ id: 'other', text: 'other', completed: false, createdAt: 1 }];
    expect(await store().saveTodos(other, todos)).toBe(true);
    expect(store().getEntry(other).todos).toEqual(todos);
    gate.resolve(emptyPayload());
    expect(await pending).toBe(true);
    expect(store().getEntry(other).todos).toEqual(todos);
  });

  test('a load started before a completed save cannot restore stale todos', async () => {
    const gate = deferred<ContextPayload>();
    handlers.fetch = () => gate.promise;
    const loading = store().load(PROJECT);
    const a = { id: 'a', text: 'new', completed: false, createdAt: 1 };
    await store().saveTodos(PROJECT, [a]);
    gate.resolve(emptyPayload());
    await loading;
    expect(entry().todos).toEqual([a]);
  });

  test('a load begun during a write stays stale after that write settles', async () => {
    const gate = deferred<ContextPayload>();
    handlers.fetch = () => gate.promise;
    const a = { id: 'a', text: 'new', completed: false, createdAt: 1 };
    const saving = store().saveTodos(PROJECT, [a]);
    const loading = store().load(PROJECT);
    await saving;
    gate.resolve(emptyPayload());
    await loading;
    expect(entry().todos).toEqual([a]);
  });

  test('a runtime reset rejects old todo completions and queued dispatches', async () => {
    const gate = deferred<ContextPayload>();
    handlers.saveTodos = () => gate.promise;
    const one = store().saveTodos(PROJECT, []);
    const two = store().saveTodos(PROJECT, []);
    await Promise.resolve();
    expect(calls.saveTodos).toBe(1);
    store().reset();
    gate.resolve(emptyPayload());
    expect(await one).toBe(false);
    expect(await two).toBe(false);
    expect(calls.saveTodos).toBe(1);
    expect(entry().loaded).toBe(false);
  });

  test('sends one todo when the change names it and shows the list the server committed', async () => {
    const mine = { id: 'mine', text: 'mine', completed: false, createdAt: 1 };
    const agents = { id: 'agent', text: 'from an agent', completed: false, createdAt: 2 };
    await store().saveTodos(PROJECT, [mine]);
    const sent: ProjectTodoChange[] = [];
    const gate = deferred<ContextPayload>();
    handlers.writeTodo = (change) => {
      sent.push(change);
      return gate.promise;
    };

    const pending = store().saveTodos(PROJECT, [{ ...mine, completed: true }], { kind: 'complete', id: 'mine', completed: true });
    expect(entry().todos).toEqual([{ ...mine, completed: true }]);

    gate.resolve({ notes: [], todos: [agents, { ...mine, completed: true }], plans: [] });
    expect(await pending).toBe(true);
    expect(sent).toEqual([{ kind: 'complete', id: 'mine', completed: true }]);
    expect(calls.saveTodos).toBe(1);
    expect(entry().todos.map((todo) => todo.id)).toEqual(['agent', 'mine']);
  });

  test('a todo someone already removed is no failure: the list is re-read', async () => {
    const mine = { id: 'mine', text: 'mine', completed: false, createdAt: 1 };
    await store().saveTodos(PROJECT, [mine]);
    handlers.writeTodo = async () => null;
    handlers.fetch = async () => emptyPayload();
    const fetchesBefore = calls.fetch;

    expect(await store().saveTodos(PROJECT, [{ ...mine, completed: true }], { kind: 'complete', id: 'mine', completed: true })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await store().load(PROJECT);

    expect(calls.fetch).toBeGreaterThan(fetchesBefore);
    expect(entry().todos).toEqual([]);
    expect(entry().error).toBeNull();
  });

  test('rolls a refused single-todo delete back like a whole-list one', async () => {
    const mine = { id: 'mine', text: 'mine', completed: false, createdAt: 1, planId: 'p1' };
    const later = { id: 'later', text: 'later', completed: false, createdAt: 2, planId: 'p1', dependsOn: ['mine'] };
    await store().saveTodos(PROJECT, [mine, later]);
    handlers.writeTodo = failWith('A dependency must link two todos of the same plan');

    expect(await store().saveTodos(PROJECT, [later], { kind: 'delete', id: 'mine' })).toBe(false);
    expect(entry().todos).toEqual([mine, later]);
    expect(entry().error).toBe('A dependency must link two todos of the same plan');
  });

  test('ignores a project without a resolvable path', async () => {
    expect(await store().saveTodos({ id: 'x', path: '' }, [])).toBe(false);
    expect(calls.saveTodos).toBe(0);
  });
});

describe('notes', () => {
  test('createNote adopts the committed list', async () => {
    handlers.createNote = async () => ({
      note: note({ id: 'n9', body: 'fresh' }),
      context: { notes: [note({ id: 'n9', body: 'fresh' })], todos: [], plans: [] },
    });

    const created = await store().createNote(PROJECT, { body: 'fresh' });
    expect(created?.id).toBe('n9');
    expect(entry().notes.map((entryNote) => entryNote.id)).toEqual(['n9']);
  });

  test('createNote refuses a whitespace-only body without calling the server', async () => {
    expect(await store().createNote(PROJECT, { body: '   ' })).toBeNull();
    expect(calls.createNote).toBe(0);
  });

  test('createNote reports failure without inserting a placeholder row', async () => {
    handlers.createNote = failWith('no space');

    expect(await store().createNote(PROJECT, { body: 'x' })).toBeNull();
    expect(entry().notes).toEqual([]);
    expect(entry().error).toBe('no space');
  });

  test('saveNoteBody applies optimistically, keeps the plan link and commits the server copy', async () => {
    const linked = note({ planId: 'p1' });
    handlers.createNote = async () => ({ note: linked, context: { notes: [linked], todos: [], plans: [] } });
    await store().createNote(PROJECT, { body: 'before' });
    const gate = deferred<NotePayload | null>();
    handlers.updateNote = () => gate.promise;

    const pending = store().saveNoteBody(PROJECT, 'n1', 'after');
    expect(entry().notes[0]).toEqual({ ...linked, body: 'after' });

    gate.resolve({ ...linked, body: 'after', updatedAt: 9 });
    expect(await pending).toBe(true);
    expect(entry().notes[0]).toEqual({ ...linked, body: 'after', updatedAt: 9 });
  });

  test('saveNoteBody rolls back on failure', async () => {
    await store().createNote(PROJECT, { body: 'before' });
    handlers.updateNote = failWith('read only');

    expect(await store().saveNoteBody(PROJECT, 'n1', 'after')).toBe(false);
    expect(entry().notes[0].body).toBe('body');
    expect(entry().error).toBe('read only');
  });

  test('saveNoteBody drops a note the server reports as gone', async () => {
    await store().createNote(PROJECT, { body: 'before' });
    handlers.updateNote = async () => null;

    expect(await store().saveNoteBody(PROJECT, 'n1', 'after')).toBe(false);
    expect(entry().notes).toEqual([]);
  });

  test('setNotePinned applies optimistically', async () => {
    await store().createNote(PROJECT, { body: 'x' });
    const gate = deferred<NotePayload | null>();
    handlers.updateNote = () => gate.promise;

    const pending = store().setNotePinned(PROJECT, 'n1', true);
    expect(entry().notes[0].pinned).toBe(true);

    gate.resolve(note({ pinned: true }));
    expect(await pending).toBe(true);
  });

  test('setNotePinned rolls back on failure', async () => {
    await store().createNote(PROJECT, { body: 'x' });
    handlers.updateNote = failWith('locked');

    expect(await store().setNotePinned(PROJECT, 'n1', true)).toBe(false);
    expect(entry().notes[0].pinned).toBe(false);
  });

  test('deleteNote removes optimistically and restores on failure', async () => {
    await store().createNote(PROJECT, { body: 'x' });
    handlers.deleteNote = failWith('busy');

    expect(await store().deleteNote(PROJECT, 'n1')).toBe(false);
    expect(entry().notes.map((entryNote) => entryNote.id)).toEqual(['n1']);
    expect(entry().error).toBe('busy');
  });

  test('deleteNote commits the server list on success', async () => {
    await store().createNote(PROJECT, { body: 'x' });

    expect(await store().deleteNote(PROJECT, 'n1')).toBe(true);
    expect(entry().notes).toEqual([]);
  });
});

describe('plans', () => {
  test('createPlan commits the server context', async () => {
    const plan = await store().createPlan(PROJECT, { title: 'A', body: 'x' });

    expect(plan?.id).toBe('p1');
    expect(entry().plans.map((item) => item.id)).toEqual(['p1']);
  });

  test('createPlan reports failure without inserting a placeholder row', async () => {
    handlers.create = failWith('no space');

    expect(await store().createPlan(PROJECT, { title: 'A', body: 'x' })).toBeNull();
    expect(entry().plans).toEqual([]);
    expect(entry().error).toBe('no space');
  });

  test('deletePlan removes optimistically', async () => {
    await store().createPlan(PROJECT, { title: 'A', body: 'x' });

    const gate = deferred<ContextPayload>();
    handlers.remove = () => gate.promise;

    const pending = store().deletePlan(PROJECT, 'p1');
    expect(entry().plans).toEqual([]);

    gate.resolve(emptyPayload());
    expect(await pending).toBe(true);
  });

  test('savePlan folds the refreshed title back into the list', async () => {
    await store().createPlan(PROJECT, { title: 'A', body: 'x' });
    handlers.update = async () => ({ plan: planLink({ title: 'Renamed' }), raw: '# Renamed' });

    expect(await store().savePlan(PROJECT, 'p1', '# Renamed')).toBe(true);
    expect(entry().plans[0].title).toBe('Renamed');
  });

  test('savePlan drops a plan the server reports as gone', async () => {
    await store().createPlan(PROJECT, { title: 'A', body: 'x' });
    handlers.update = async () => null;

    expect(await store().savePlan(PROJECT, 'p1', '# X')).toBe(false);
    expect(entry().plans).toEqual([]);
  });

  test('savePlan keeps the row and reports the error when the request fails', async () => {
    await store().createPlan(PROJECT, { title: 'A', body: 'x' });
    handlers.update = failWith('read only');

    expect(await store().savePlan(PROJECT, 'p1', '# X')).toBe(false);
    expect(entry().plans.map((item) => item.id)).toEqual(['p1']);
    expect(entry().error).toBe('read only');
  });

  test('setPlanPinned applies optimistically and rolls back on failure', async () => {
    await store().createPlan(PROJECT, { title: 'A', body: 'x' });
    handlers.pinPlan = failWith('locked');

    expect(await store().setPlanPinned(PROJECT, 'p1', true)).toBe(false);
    expect(entry().plans[0].pinned).toBe(false);
    expect(entry().error).toBe('locked');
  });

  test('setPlanPinned commits the server copy', async () => {
    await store().createPlan(PROJECT, { title: 'A', body: 'x' });

    expect(await store().setPlanPinned(PROJECT, 'p1', true)).toBe(true);
    expect(entry().plans[0].pinned).toBe(true);
  });

  test('deletePlan restores the row when the request fails', async () => {
    await store().createPlan(PROJECT, { title: 'A', body: 'x' });
    handlers.remove = failWith('locked');

    expect(await store().deletePlan(PROJECT, 'p1')).toBe(false);
    expect(entry().plans.map((item) => item.id)).toEqual(['p1']);
    expect(entry().error).toBe('locked');
  });
});

describe('review regressions', () => {
  test('an older forced load is read again after a newer failed todo save, never applied stale', async () => {
    const todos = [{ id: 'a', text: 'confirmed', completed: false, createdAt: 1 }];
    await store().saveTodos(PROJECT, todos);
    const gate = deferred<ContextPayload>();
    let reads = 0;
    handlers.fetch = () => (++reads === 1 ? gate.promise : Promise.resolve({ ...emptyPayload(), todos }));
    const loading = store().load(PROJECT, { force: true });
    handlers.saveTodos = failWith('disk full');
    expect(await store().saveTodos(PROJECT, [])).toBe(false);
    expect(entry().todos).toEqual(todos);
    expect(entry().error).toBe('disk full');
    gate.resolve(emptyPayload());
    await loading;
    expect(reads).toBe(2);
    expect(entry().todos).toEqual(todos);
    expect(entry().error).toBeNull();
  });

  for (const kind of ['note', 'plan'] as const) {
    for (const outcome of ['success', 'failure'] as const) {
      test(`old runtime ${kind} creation ${outcome} cannot suppress destination todo hydration`, async () => {
        const gate = deferred<ContextPayload>();
        if (kind === 'note') {
          handlers.createNote = async () => ({ note: note(), context: await gate.promise });
        } else {
          handlers.create = async () => ({ plan: planLink(), context: await gate.promise });
        }
        const pending = kind === 'note'
          ? store().createNote(PROJECT, { body: 'old runtime' })
          : store().createPlan(PROJECT, { title: 'old runtime', body: 'body' });
        await Promise.resolve();
        store().reset();
        if (outcome === 'success') gate.resolve(emptyPayload());
        else gate.reject(new Error('old runtime failure'));
        expect(await pending).toBeNull();
        expect(entry().loaded).toBe(false);
        expect(entry().error).toBeNull();
        const todos = [{ id: 'b', text: 'destination', completed: false, createdAt: 1 }];
        handlers.fetch = async () => ({ ...emptyPayload(), todos });
        await store().load(PROJECT);
        expect(calls.fetch).toBe(1);
        expect(entry().todos).toEqual(todos);
      });
    }
  }

  for (const action of ['saveNoteBody', 'setNotePinned', 'deleteNote', 'savePlan', 'setPlanPinned', 'deletePlan'] as const) {
    for (const outcome of ['success', 'failure'] as const) {
      test(`reset rejects ${action} ${outcome} without changing the destination cache`, async () => {
        const gate = deferred<ContextPayload>();
        handlers.updateNote = async () => { await gate.promise; return note(); };
        handlers.deleteNote = () => gate.promise;
        handlers.update = async () => { await gate.promise; return { plan: planLink(), raw: '# A' }; };
        handlers.pinPlan = async () => { await gate.promise; return planLink(); };
        handlers.remove = () => gate.promise;
        const run = () => {
          switch (action) {
            case 'saveNoteBody': return store().saveNoteBody(PROJECT, 'n1', 'new');
            case 'setNotePinned': return store().setNotePinned(PROJECT, 'n1', true);
            case 'deleteNote': return store().deleteNote(PROJECT, 'n1');
            case 'savePlan': return store().savePlan(PROJECT, 'p1', '# New');
            case 'setPlanPinned': return store().setPlanPinned(PROJECT, 'p1', true);
            case 'deletePlan': return store().deletePlan(PROJECT, 'p1');
          }
        };
        const pending = run();
        await Promise.resolve();
        store().reset();
        const todos = [{ id: 'b', text: 'destination', completed: false, createdAt: 1 }];
        handlers.fetch = async () => ({ ...emptyPayload(), todos });
        await store().load(PROJECT);
        const destination = entry();
        if (outcome === 'success') gate.resolve(emptyPayload());
        else gate.reject(new Error('old runtime failure'));
        expect(await pending).toBe(false);
        expect(entry()).toBe(destination);
      });
    }
  }

  test('reset cancels queued note and plan dispatch behind an old write', async () => {
    const gate = deferred<ContextPayload>();
    handlers.saveTodos = () => gate.promise;
    const saving = store().saveTodos(PROJECT, []);
    const creatingNote = store().createNote(PROJECT, { body: 'queued' });
    const creatingPlan = store().createPlan(PROJECT, { title: 'queued', body: 'body' });
    await Promise.resolve();
    store().reset();
    gate.resolve(emptyPayload());
    expect(await saving).toBe(false);
    expect(await creatingNote).toBeNull();
    expect(await creatingPlan).toBeNull();
    expect(calls.createNote).toBe(0);
    expect(calls.create).toBe(0);
    expect(entry().loaded).toBe(false);
  });
});

describe('reset', () => {
  test('drops every cached project', async () => {
    await store().load(PROJECT);
    expect(entry().loaded).toBe(true);

    store().reset();
    expect(entry().loaded).toBe(false);
  });
});
