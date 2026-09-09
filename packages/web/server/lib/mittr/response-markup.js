/**
 * Watches model output for the model's own markup arriving as text.
 *
 * This exists because of a failure the team has already paid for: when the
 * gateway's tool parser does not match the model, the model's tool call is
 * emitted as ordinary text and `tool_calls` comes back empty. Nothing errors.
 * The agent simply stops using tools, and for a coding agent that is total
 * failure wearing the face of a chatty reply.
 *
 * It reports; it never edits. Quietly deleting the markup would remove the only
 * evidence on the day the parser actually breaks, which is the day the evidence
 * matters. Cleaning output for display is a separate decision that belongs where
 * the text is rendered.
 */

// A tool call the model wrote out as text. Shapes taken from what this team has
// measured: gemma-4 emits `<|tool_call>call:fn{...}`, qwen's XML template emits
// `<function=...><parameter=...>`, and hermes-style parsers emit `<tool_call>`.
const TOOL_CALL_MARKERS = ['<|tool_call>', '<function=', '<tool_call>'];

// Reasoning or channel scaffolding. Cosmetic: it is ugly in a transcript but the
// loop still runs. Observed on gemma-4 as `<|channel>thought\n<channel|>`.
const CHANNEL_MARKERS = ['<|channel>', '<channel|>', '<|thought>'];

const ALL_MARKERS = [...TOOL_CALL_MARKERS, ...CHANNEL_MARKERS];
const LONGEST_MARKER = Math.max(...ALL_MARKERS.map((marker) => marker.length));

const findMarkers = (text) => ALL_MARKERS.filter((marker) => text.includes(marker));

const classify = (markers, hasToolCalls) => {
  if (markers.length === 0) return { kind: 'clean', markers: [] };
  const lostToolCall = !hasToolCalls && markers.some((marker) => TOOL_CALL_MARKERS.includes(marker));
  return { kind: lostToolCall ? 'tool-calls-lost' : 'channel-markup', markers };
};

/** For a complete response, where the whole content is in hand. */
export const describeMarkup = ({ content, hasToolCalls = false } = {}) => {
  if (typeof content !== 'string' || !content) return { kind: 'clean', markers: [] };
  return classify(findMarkers(content), hasToolCalls);
};

/**
 * Watches decoded content as it streams, keeping only enough tail to notice a
 * marker split across two deltas — which is the normal case when a model streams
 * token by token, not an exotic one.
 */
export const createMarkupWatcher = () => {
  const seen = new Set();
  let carry = '';
  let hasToolCalls = false;

  return {
    observe(text) {
      const window = carry + String(text ?? '');
      for (const marker of ALL_MARKERS) {
        if (window.includes(marker)) seen.add(marker);
      }
      carry = window.slice(-(LONGEST_MARKER - 1));
    },
    noteToolCall() {
      hasToolCalls = true;
    },
    result() {
      return classify([...seen], hasToolCalls);
    },
    /** Exposed so a test can prove the watcher does not grow with the stream. */
    bufferedLength() {
      return carry.length;
    },
  };
};

/**
 * Watches a server-sent event stream on its way past, without buffering it and
 * without altering a byte.
 *
 * It reads the decoded content rather than the raw bytes, which a first version
 * did not: between two halves of a marker split across deltas sits the protocol
 * frame — `"}}]}\n\ndata: {...}"content":"` — so the raw bytes never join up and
 * the split marker, the very case token-by-token streaming produces, went
 * unseen.
 */
export const createStreamMarkupWatcher = () => {
  const watcher = createMarkupWatcher();
  let lineCarry = '';

  const readEvent = (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let delta;
    try {
      delta = JSON.parse(payload)?.choices?.[0]?.delta;
    } catch {
      // A frame we cannot read is not a failure of the response; it just tells
      // us nothing.
      return;
    }
    if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) watcher.noteToolCall();
    if (typeof delta?.content === 'string') watcher.observe(delta.content);
  };

  return {
    observe(chunk) {
      const text = lineCarry + Buffer.from(chunk).toString('utf8');
      const lines = text.split('\n');
      // The last piece may be half a line; hold it for the next chunk.
      lineCarry = lines.pop() ?? '';
      for (const line of lines) readEvent(line);
    },
    finish() {
      if (lineCarry) readEvent(lineCarry);
      lineCarry = '';
      return watcher.result();
    },
  };
};
