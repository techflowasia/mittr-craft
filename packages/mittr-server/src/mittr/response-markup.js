/**
 * Watches model output for the model's own markup arriving as text.
 *
 * When the gateway's tool parser does not match the model, the model's tool
 * call comes back as ordinary text and `tool_calls` is empty. Nothing errors:
 * the agent just stops using tools, which for a coding agent is total failure
 * that looks like a chatty reply.
 *
 * It reports and never edits. Deleting the markup would remove the only
 * evidence on the day the parser breaks, which is the day it matters.
 */

// Measured shapes: gemma-4 writes `<|tool_call>call:fn{...}`, qwen's XML
// template `<function=...><parameter=...>`, hermes-style parsers `<tool_call>`.
const TOOL_CALL_MARKERS = ['<|tool_call>', '<function=', '<tool_call>'];

// Reasoning or channel scaffolding: ugly in a transcript, but the loop still
// runs. Seen on gemma-4 as `<|channel>thought\n<channel|>`.
const CHANNEL_MARKERS = ['<|channel>', '<channel|>', '<|thought>'];

const ALL_MARKERS = [...TOOL_CALL_MARKERS, ...CHANNEL_MARKERS];
const LONGEST_MARKER = Math.max(...ALL_MARKERS.map((marker) => marker.length));

const classify = (markers, hasToolCalls) => {
  if (markers.length === 0) return { kind: 'clean', markers: [] };
  const lostToolCall = !hasToolCalls && markers.some((marker) => TOOL_CALL_MARKERS.includes(marker));
  return { kind: lostToolCall ? 'tool-calls-lost' : 'channel-markup', markers };
};

/** For a complete response, with the whole content in hand. */
export const describeMarkup = ({ content, hasToolCalls = false } = {}) => {
  if (typeof content !== 'string' || !content) return { kind: 'clean', markers: [] };
  return classify(ALL_MARKERS.filter((marker) => content.includes(marker)), hasToolCalls);
};

/**
 * Watches decoded content as it streams, keeping only enough tail to notice a
 * marker split across two deltas, which token-by-token streaming does all the
 * time.
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
    /** For a test to prove the watcher does not grow with the stream. */
    bufferedLength() {
      return carry.length;
    },
  };
};

/**
 * Watches a server-sent event stream on its way past without holding it up
 * or changing a byte. It reads each delta's decoded content, not the raw
 * bytes: between two halves of a split marker sits the protocol frame, so
 * the raw bytes never join up.
 */
export const createStreamMarkupWatcher = () => {
  const watcher = createMarkupWatcher();
  const decoder = new TextDecoder();
  let lineCarry = '';

  const readEvent = (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let delta;
    try {
      delta = JSON.parse(payload)?.choices?.[0]?.delta;
    } catch {
      // A frame that cannot be read says nothing about the answer.
      return;
    }
    if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) watcher.noteToolCall();
    if (typeof delta?.content === 'string') watcher.observe(delta.content);
  };

  return {
    observe(chunk) {
      const lines = (lineCarry + decoder.decode(chunk, { stream: true })).split('\n');
      // The last piece may be half a line; hold it for the next chunk.
      lineCarry = lines.pop() ?? '';
      for (const line of lines) readEvent(line.trimEnd());
    },
    finish() {
      readEvent((lineCarry + decoder.decode()).trimEnd());
      lineCarry = '';
      return watcher.result();
    },
  };
};
