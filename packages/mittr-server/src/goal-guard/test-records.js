let counter = 0;

export const toolPart = (name, input, { status = 'completed', error = null, output = 'ok', exit } = {}) => {
  const state = error ? { status: 'error', input, error } : { status, input, content: [{ type: 'text', text: output }] };
  if (!error && exit !== undefined) state.metadata = { status, exit };
  return { type: 'tool', id: `call_${(counter += 1)}`, name, state };
};

export const step = (parts, snapshot) => {
  const record = {
    id: `msg_${String((counter += 1)).padStart(6, '0')}`,
    type: 'assistant',
    content: Array.isArray(parts) ? parts : [parts],
    finish: 'tool-calls',
    time: { created: counter, completed: counter + 1 },
  };
  if (snapshot) record.snapshot = { files: snapshot.start === snapshot.end ? [] : ['a.ts'], ...snapshot };
  return record;
};

export const shell = (command, output, exit) => toolPart('shell', { command }, { output, exit });
export const read = (path) => toolPart('read', { path });
export const edit = (path, oldString, newString) => toolPart('edit', { path, oldString, newString });
export const noopEdit = (path, text) => toolPart('edit', { path, oldString: text, newString: text }, {
  error: { type: 'tool.execution', message: 'No changes to apply: oldString and newString are identical.' },
});
export const failed = (name, input) => toolPart(name, input, { error: { type: 'tool.execution', message: 'failed' } });
