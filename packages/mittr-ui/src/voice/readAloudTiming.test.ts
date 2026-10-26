import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';

import { runChunkedTTSPlayback, splitSentencesForTTS } from '../../../ui/src/hooks/useServerTTS';

const SYNTHESIS_MS = 2000;
const CHARACTERS_PER_SECOND = 14;
const ANSWER_LENGTH = 6000;
const LONG_THAI_LENGTH = 4200;
const STEP_MS = 50;

const ENGLISH = [
  'The build finished and every test passed on the first run this morning.',
  'Next I will open the report and read the three warnings out loud for you.',
  'The second warning is about a file that nobody has touched for two years.',
  'If you want, I can archive that file and keep a copy in the old folder.',
];
const THAI = [
  'ระบบพร้อมใช้งานแล้วและทุกขั้นตอนผ่านการตรวจสอบเรียบร้อยดีครับ.',
  'ต่อไปผมจะเปิดรายงานแล้วอ่านคำเตือนทั้งสามข้อให้ฟังทีละข้อนะครับ.',
];
const THAI_RUN = 'ขั้นตอนต่อไปคือการตรวจสอบไฟล์ทั้งหมดอีกครั้งและบันทึกผลไว้ในโฟลเดอร์เดิม ';

const longThaiSentence = (): string => {
  let text = '';
  while (text.length < LONG_THAI_LENGTH) text += THAI_RUN;
  return text.slice(0, LONG_THAI_LENGTH - 1).trimEnd().padEnd(LONG_THAI_LENGTH - 1, 'ม') + 'ม';
};

const buildAnswer = () => {
  const longThai = longThaiSentence();
  const opening = [ENGLISH[0], THAI[0], ENGLISH[1], THAI[1], ENGLISH[2]].join(' ');
  let closing = '';
  let index = 0;
  const target = ANSWER_LENGTH - opening.length - longThai.length - 4;
  while (closing.length < target) {
    const sentence = index % 2 === 0 ? ENGLISH[(index / 2) % ENGLISH.length] : THAI[((index - 1) / 2) % THAI.length];
    closing = closing ? `${closing} ${sentence}` : sentence;
    index += 1;
  }
  closing = closing.slice(0, target).trimEnd();
  const text = `${opening}\n\n${longThai}\n\n${closing.padEnd(target, '.')}`;
  return { text, longThai };
};

type Scheduled = { index: number; chars: number; fetchStartsAt: number; fetchEndsAt: number; startsAt: number; endsAt: number };

const play = async (chunks: readonly string[]) => {
  let virtualMs = 0;
  const fetches: { chars: number; startsAt: number }[] = [];
  const scheduled: Scheduled[] = [];
  const endHandlers: { endsAt: number; handler: () => void; fired: boolean }[] = [];
  let firstScheduledAt: number | null = null;
  let allEndedAt: number | null = null;
  const controller = new AbortController();
  let finished = false;
  const run = runChunkedTTSPlayback<{ chars: number; fetchIndex: number }, Scheduled>(chunks, {
    signal: controller.signal,
    fetchChunk: (chunk) => new Promise((resolve) => {
      const fetchIndex = fetches.push({ chars: chunk.length, startsAt: virtualMs / 1000 }) - 1;
      setTimeout(() => resolve({ chars: chunk.length, fetchIndex }), SYNTHESIS_MS);
    }),
    scheduleChunk: (buffer, startAt) => {
      const entry: Scheduled = {
        index: scheduled.length,
        chars: buffer.chars,
        fetchStartsAt: fetches[buffer.fetchIndex].startsAt,
        fetchEndsAt: virtualMs / 1000,
        startsAt: startAt,
        endsAt: startAt + buffer.chars / CHARACTERS_PER_SECOND,
      };
      scheduled.push(entry);
      return { source: entry, endsAt: entry.endsAt };
    },
    currentTime: () => virtualMs / 1000,
    attachOnEnded: (source, handler) => { endHandlers.push({ endsAt: source.endsAt, handler, fired: false }); },
    onScheduled: () => {},
    onFirstScheduled: () => { firstScheduledAt = virtualMs / 1000; },
    onAllEnded: () => { allEndedAt = virtualMs / 1000; },
  }).then((outcome) => { finished = true; return outcome; });
  for (let guard = 0; guard < 100_000 && (!finished || allEndedAt === null); guard += 1) {
    for (let flush = 0; flush < 5; flush += 1) await Promise.resolve();
    for (const end of endHandlers) {
      if (!end.fired && end.endsAt <= virtualMs / 1000) {
        end.fired = true;
        end.handler();
      }
    }
    if (finished && allEndedAt !== null) break;
    virtualMs += STEP_MS;
    jest.advanceTimersByTime(STEP_MS);
  }
  const outcome = await run;
  return { outcome, scheduled, fetches, firstScheduledAt, allEndedAt };
};

const largestGap = (scheduled: Scheduled[]): number => scheduled.reduce((gap, entry, index) => (
  index === 0 ? gap : Math.max(gap, entry.startsAt - scheduled[index - 1].endsAt)
), 0);

describe('upstream chunked read-aloud with 2 s synthesis and 14 characters per second', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('a 6000-character Thai and English answer: chunk sizes, first audio, gaps and prefetch', async () => {
    const { text, longThai } = buildAnswer();
    expect(text.length).toBe(ANSWER_LENGTH);
    expect(longThai.length).toBe(LONG_THAI_LENGTH);
    expect(longThai.includes('.')).toBe(false);

    const chunks = splitSentencesForTTS(text);
    const longest = Math.max(...chunks.map((chunk) => chunk.length));
    const { outcome, scheduled, firstScheduledAt, allEndedAt } = await play(chunks);
    const gap = largestGap(scheduled);
    const prefetchWhilePlaying = scheduled.slice(0, -1).map((entry, index) => scheduled[index + 1].fetchStartsAt < entry.endsAt);
    const facts = {
      chunks: chunks.length,
      chunkLengths: chunks.map((chunk) => chunk.length),
      longestChunk: longest,
      firstAudioSeconds: firstScheduledAt,
      largestGapSeconds: Number(gap.toFixed(3)),
      everyNextFetchedWhilePlaying: prefetchWhilePlaying.every(Boolean),
      totalSeconds: allEndedAt,
      outcome,
    };
    console.info(`S3 ${JSON.stringify(facts)}`);

    expect(outcome).toEqual({ status: 'completed', scheduled: chunks.length });
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' ').trim());
    expect(longest).toBeGreaterThan(4000);
    expect(chunks.some((chunk) => chunk.includes(longThai))).toBe(true);
    expect(firstScheduledAt).toBe(SYNTHESIS_MS / 1000);
    expect(gap).toBeLessThanOrEqual(SYNTHESIS_MS / 1000);
    expect(prefetchWhilePlaying.every(Boolean)).toBe(true);
    for (const [index, entry] of scheduled.entries()) {
      expect(Math.abs(entry.fetchEndsAt - entry.fetchStartsAt - SYNTHESIS_MS / 1000)).toBeLessThan(1e-6);
      if (index > 0) expect(Math.abs(entry.fetchStartsAt - scheduled[index - 1].fetchEndsAt)).toBeLessThan(1e-6);
    }
  });

  test('chunks are fetched one at a time, so a chunk shorter than 2 s of speech leaves a gap', async () => {
    const short = Array.from({ length: 4 }, (_, index) => `Line ${index + 1} is ok.`);
    const { scheduled } = await play(short);
    const gap = largestGap(scheduled);
    expect(scheduled.length).toBe(4);
    expect(gap).toBeGreaterThan(0);
    expect(Math.abs(gap - (SYNTHESIS_MS / 1000 - short[0].length / CHARACTERS_PER_SECOND))).toBeLessThan(0.06);
  });
});
