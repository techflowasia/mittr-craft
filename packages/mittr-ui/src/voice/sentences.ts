export const LONG_CLAUSE_CHARS = 60;

const BOUNDARY = /[.!?…。！？]+(?=\s)|\n/;
const THAI = /\p{Script=Thai}/u;
const SPOKEN = /[\p{L}\p{N}]/u;

export interface SentenceSplitter {
  push(text: string): string[];
  end(): string[];
}

export function createSentenceSplitter(): SentenceSplitter {
  let buffer = "";

  const keep = (piece: string, out: string[]) => {
    const sentence = piece.trim();
    if (SPOKEN.test(sentence)) out.push(sentence);
  };

  return {
    push(text) {
      buffer += text;
      const out: string[] = [];
      for (;;) {
        const found = BOUNDARY.exec(buffer);
        if (!found) break;
        const cut = found.index + (found[0] === "\n" ? 0 : found[0].length);
        keep(buffer.slice(0, cut), out);
        buffer = buffer.slice(found[0] === "\n" ? cut + 1 : cut);
      }
      if (buffer.length >= LONG_CLAUSE_CHARS && THAI.test(buffer)) {
        const space = buffer.trimEnd().lastIndexOf(" ");
        if (space > 0) {
          keep(buffer.slice(0, space), out);
          buffer = buffer.slice(space + 1);
        }
      }
      return out;
    },
    end() {
      const out: string[] = [];
      keep(buffer, out);
      buffer = "";
      return out;
    },
  };
}
