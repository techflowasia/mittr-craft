import { describe, expect, test } from "bun:test";
import { LONG_CLAUSE_CHARS, createSentenceSplitter } from "./sentences";

function run(chunks: string[]): string[] {
  const splitter = createSentenceSplitter();
  const out: string[] = [];
  for (const chunk of chunks) out.push(...splitter.push(chunk));
  out.push(...splitter.end());
  return out;
}

describe("createSentenceSplitter", () => {
  test("cuts after a full stop, an exclamation mark and a question mark", () => {
    const splitter = createSentenceSplitter();
    expect(splitter.push("Hello there. How ")).toEqual(["Hello there."]);
    expect(splitter.push("are you? Great! Bye")).toEqual([
      "How are you?",
      "Great!",
    ]);
    expect(splitter.end()).toEqual(["Bye"]);
  });

  test("does not cut inside a number or an abbreviation mid-stream", () => {
    expect(run(["Version 3.", "5 is out. Next"])).toEqual([
      "Version 3.5 is out.",
      "Next",
    ]);
  });

  test("cuts at a newline", () => {
    expect(run(["First line\nSecond", " line"])).toEqual([
      "First line",
      "Second line",
    ]);
  });

  test("cuts a long Thai clause at a space once the buffer passes the threshold", () => {
    const clause = "ก".repeat(LONG_CLAUSE_CHARS);
    const splitter = createSentenceSplitter();
    expect(splitter.push("สั้น ๆ")).toEqual([]);
    expect(splitter.push(` ${clause} ต่อ`)).toEqual([`สั้น ๆ ${clause}`]);
    expect(splitter.end()).toEqual(["ต่อ"]);
  });

  test("leaves a short Thai clause whole until the stream ends", () => {
    expect(run(["เริ่มงาน ให้แล้ว", "ครับ"])).toEqual(["เริ่มงาน ให้แล้วครับ"]);
  });

  test("does not cut long English text at a space", () => {
    const long = Array.from({ length: 30 }, () => "word").join(" ");
    const splitter = createSentenceSplitter();
    expect(splitter.push(long)).toEqual([]);
    expect(splitter.end()).toEqual([long]);
  });

  test("hands over the remainder at the end of the stream", () => {
    expect(run(["no punctuation at all"])).toEqual(["no punctuation at all"]);
  });

  test("never yields an empty sentence", () => {
    expect(run(["", "  ", "\n\n", "!? ", ". ", "\n"])).toEqual([]);
    expect(run(["Wow!! ", "Really"])).toEqual(["Wow!!", "Really"]);
    expect(run(["Done.\n\n  \n"])).toEqual(["Done."]);
    expect(run([])).toEqual([]);
  });
});
