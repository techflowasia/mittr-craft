import { createHash } from 'node:crypto';

export const REPEAT_LIMIT = 3;
export const NOOP_EDIT_LIMIT = 5;
const NOOP_EDIT_SHARE = 0.1;
export const FAILURE_MIN_CALLS = 20;
const FAILURE_SHARE = 0.2;
export const STALLED_TURN_LIMIT = 3;

const WRITE_TOOLS = new Set(['edit', 'write', 'multiedit', 'apply_patch', 'patch']);
const SUBJECT_CHARS = 80;

const isRecord = (value) => value instanceof Object && !Array.isArray(value);

const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

const VOLATILE_OUTPUT = [
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g,
  /\b\d{1,2}:\d{2}:\d{2}(\.\d+)?\b/g,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi,
  /\b\d+(\.\d+)?\s?(ms|s|sec|secs|seconds|m|min|minutes)\b/gi,
];

const outputText = (state) => {
  if (state?.status === 'error') return String(state.error?.message ?? '');
  return (Array.isArray(state?.content) ? state.content : []).map((part) => String(part?.text ?? '')).join('\n');
};

const resultDigest = (state) => {
  const normalised = VOLATILE_OUTPUT.reduce((text, pattern) => text.replace(pattern, ''), outputText(state)).replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalised).digest('hex');
};

const FAILING_OUTPUT = /\bFAIL(ED|URE)?\b|\b[1-9]\d* (failed|failing|fail)\b|\bnot ok \d|npm ERR!|\bError: /;

const failedResult = (state) => {
  if (state?.status === 'error') return true;
  const exit = state?.metadata?.exit;
  if (exit !== undefined && exit !== null && Number(exit) !== 0) return true;
  return FAILING_OUTPUT.test(outputText(state));
};

const toolParts = (record) => (Array.isArray(record?.content) ? record.content : [])
  .filter((part) => isRecord(part) && part.type === 'tool' && part.name);

const firstLine = (value) => String(value ?? '').trim().split('\n')[0].slice(0, SUBJECT_CHARS);

const subjectOf = (name, input) => {
  if (!isRecord(input)) return '';
  if (name === 'shell' || name === 'bash') return firstLine(input.command);
  return firstLine(input.path ?? input.filePath ?? input.pattern ?? '');
};

const isNoopEdit = (part) => {
  const input = part.state?.input;
  return part.name === 'edit' && isRecord(input) && input.oldString != null && input.oldString === input.newString;
};

const snapshotChange = (record) => {
  const snapshot = record?.snapshot;
  if (!isRecord(snapshot) || !snapshot.end) return null;
  return { start: String(snapshot.start ?? ''), end: String(snapshot.end) };
};

export const summarizeTurn = (records) => {
  const seenStates = new Set();
  let sinceChange = new Map();
  let repeat = null;
  let calls = 0;
  let failed = 0;
  let edits = 0;
  let noopEdits = 0;
  let changedFiles = false;

  for (const record of records) {
    const snapshot = snapshotChange(record);
    if (snapshot?.start && seenStates.size === 0) seenStates.add(snapshot.start);
    for (const part of toolParts(record)) {
      calls += 1;
      const status = part.state?.status;
      if (status === 'error') failed += 1;
      if (part.name === 'edit') edits += 1;
      if (isNoopEdit(part)) noopEdits += 1;
      if (failedResult(part.state)) {
        const key = `${part.name}\u0000${stableJson(part.state?.input)}\u0000${resultDigest(part.state)}`;
        const count = (sinceChange.get(key) ?? 0) + 1;
        sinceChange.set(key, count);
        if (!repeat || count > repeat.count) repeat = { count, tool: part.name, subject: subjectOf(part.name, part.state?.input) };
      }
      if (!snapshot && status === 'completed' && WRITE_TOOLS.has(part.name)) {
        changedFiles = true;
        sinceChange = new Map();
      }
    }
    if (snapshot && snapshot.end !== snapshot.start && !seenStates.has(snapshot.end)) {
      seenStates.add(snapshot.end);
      changedFiles = true;
      sinceChange = new Map();
    }
  }

  return { calls, failed, edits, noopEdits, repeat, changedFiles };
};

const repeatedCall = ({ tool, subject }) => {
  if (!subject) return `${tool} call`;
  return tool === 'shell' || tool === 'bash' ? `command "${subject}"` : `${tool} of ${subject}`;
};

export const loopSigns = (summary, { stalledTurns = 0 } = {}) => {
  const signs = [];
  if (summary.repeat && summary.repeat.count >= REPEAT_LIMIT) {
    const call = repeatedCall(summary.repeat);
    signs.push({
      kind: 'repeat',
      count: summary.repeat.count,
      reason: `same ${call} ${summary.repeat.count} times`,
      detail: `ran the same ${call} ${summary.repeat.count} times, failing the same way, with no file changed in between`,
    });
  }
  if (summary.noopEdits >= NOOP_EDIT_LIMIT && summary.noopEdits >= summary.edits * NOOP_EDIT_SHARE) {
    signs.push({
      kind: 'noopEdits',
      count: summary.noopEdits,
      reason: `${summary.noopEdits} edits changed nothing`,
      detail: `made ${summary.noopEdits} edits whose old and new text were the same, so they changed nothing`,
    });
  }
  if (summary.calls >= FAILURE_MIN_CALLS && summary.failed >= summary.calls * FAILURE_SHARE) {
    signs.push({
      kind: 'failures',
      count: summary.failed,
      reason: `${summary.failed} of ${summary.calls} tool calls failed`,
      detail: `had ${summary.failed} of ${summary.calls} tool calls fail`,
    });
  }
  if (stalledTurns >= STALLED_TURN_LIMIT) {
    signs.push({
      kind: 'stalled',
      count: stalledTurns,
      reason: `no file changed and no commit in ${stalledTurns} turns`,
      detail: `has changed no file and committed nothing in ${stalledTurns} runs in a row`,
    });
  }
  return signs;
};
