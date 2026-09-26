const EDIT_TOOLS = new Set(['edit', 'write', 'apply_patch', 'patch', 'multiedit']);
const OUTPUT_TAIL_CHARS = 600;
const INPUT_CHARS = 400;
const REPORT_CHAR_LIMIT = 8_000;
const DIGEST_CHAR_LIMIT = 40_000;

const text = (value) => (typeof value === 'string' ? value : '');

const tail = (value, limit) => {
  const content = text(value).trim();
  return content.length > limit ? `…${content.slice(-limit)}` : content;
};

const describeInput = (tool, input) => {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.command === 'string') return `$ ${input.command}`;
  if (typeof input.url === 'string') return input.url;
  if (typeof input.query === 'string') return `query: ${input.query}`;
  const filePath = input.filePath ?? input.path;
  if (typeof filePath === 'string') return filePath;
  if (tool === 'question' && Array.isArray(input.questions)) {
    return input.questions
      .map((entry) => text(entry?.question))
      .filter(Boolean)
      .join(' | ');
  }
  try {
    return JSON.stringify(input).slice(0, INPUT_CHARS);
  } catch {
    return '';
  }
};

const toolEntry = (part, index) => {
  const state = part.state && typeof part.state === 'object' ? part.state : {};
  const input = state.input && typeof state.input === 'object' ? state.input : {};
  const metadata = state.metadata && typeof state.metadata === 'object' ? state.metadata : {};
  const status = typeof state.status === 'string' ? state.status : 'unknown';
  const output = status === 'error' ? text(state.error) : text(state.output);
  return {
    index,
    tool: typeof part.tool === 'string' ? part.tool : 'unknown',
    status,
    command: typeof input.command === 'string' ? input.command : '',
    exit: Number.isInteger(metadata.exit) ? metadata.exit : null,
    edit: EDIT_TOOLS.has(part.tool),
    input: describeInput(part.tool, input),
    output,
    corpus: `${JSON.stringify(input)}\n${output}`,
  };
};

const formatEntry = (entry) => {
  const head = [`#${entry.index + 1}`, entry.tool, entry.status];
  if (entry.exit !== null) head.push(`exit=${entry.exit}`);
  const lines = [head.join(' ')];
  if (entry.input) lines.push(`  input: ${entry.input.slice(0, INPUT_CHARS)}`);
  const output = tail(entry.output, OUTPUT_TAIL_CHARS);
  if (output) lines.push(`  output: ${output.replace(/\n/g, '\n    ')}`);
  return lines.join('\n');
};

const buildDigest = (entries) => {
  if (entries.length === 0) return 'No tool calls were made in this goal.';
  const kept = [];
  let size = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const block = formatEntry(entries[i]);
    if (size + block.length > DIGEST_CHAR_LIMIT) {
      kept.push(`(${i + 1} earlier tool calls omitted)`);
      break;
    }
    kept.push(block);
    size += block.length + 1;
  }
  return kept.reverse().join('\n');
};

export const collectGoalEvidence = (messages, { since = 0 } = {}) => {
  const list = Array.isArray(messages) ? messages : [];
  const entries = [];
  let lastUserIndex = -1;
  list.forEach((message, position) => {
    if (message?.info?.role === 'user') lastUserIndex = position;
  });
  const reportParts = [];
  list.forEach((message, position) => {
    const info = message?.info;
    if (!info) return;
    const created = Number.isFinite(info.time?.created) ? info.time.created : 0;
    if (since && created && created < since) return;
    const parts = Array.isArray(message.parts) ? message.parts : [];
    if (info.role !== 'assistant') return;
    for (const part of parts) {
      if (part?.type === 'tool') entries.push(toolEntry(part, entries.length));
      if (position > lastUserIndex && part?.type === 'text' && !part.synthetic) {
        reportParts.push(text(part.text));
      }
    }
  });
  const report = reportParts.join('\n').trim();
  return {
    entries,
    report: report.length > REPORT_CHAR_LIMIT ? report.slice(-REPORT_CHAR_LIMIT) : report,
    digest: buildDigest(entries),
    corpus: entries.map((entry) => entry.corpus).join('\n'),
  };
};
