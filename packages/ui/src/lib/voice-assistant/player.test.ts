import { describe, expect, test } from "bun:test";
import {
  createAudioPlayer,
  pcm16ToFloat32,
  pcmRate,
  type AudioOut,
} from "./player";

type FakeSource = {
  buffer: { duration: number; sampleRate: number; samples: Float32Array };
  when: number;
  stopped: boolean;
  onended: (() => void) | null;
  end(): void;
};

function fakeContext() {
  const sources: FakeSource[] = [];
  const decoded: ArrayBuffer[] = [];
  const context = {
    currentTime: 0,
    destination: {},
    createBuffer(_channels: number, length: number, sampleRate: number) {
      const samples = new Float32Array(length);
      return {
        duration: length / sampleRate,
        sampleRate,
        samples,
        getChannelData: () => samples,
      };
    },
    createBufferSource() {
      const source: FakeSource = {
        buffer: null as unknown as FakeSource["buffer"],
        when: -1,
        stopped: false,
        onended: null,
        end() {
          source.onended?.();
        },
      };
      const node = {
        set buffer(value: FakeSource["buffer"]) {
          source.buffer = value;
        },
        get onended() {
          return source.onended;
        },
        set onended(fn: (() => void) | null) {
          source.onended = fn;
        },
        connect() {},
        start(when: number) {
          source.when = when;
          sources.push(source);
        },
        stop() {
          if (source.stopped) return;
          source.stopped = true;
          source.onended?.();
        },
      };
      return node;
    },
    async decodeAudioData(data: ArrayBuffer) {
      decoded.push(data);
      return context.createBuffer(1, 4800, 48000);
    },
  };
  return {
    context: context as unknown as AudioOut,
    sources,
    decoded,
    raw: context,
  };
}

function streamOf(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function manualStream() {
  let push!: (chunk: Uint8Array) => void;
  let close!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (chunk) => controller.enqueue(chunk);
      close = () => controller.close();
    },
  });
  return { body, push: (c: Uint8Array) => push(c), close: () => close() };
}

const PCM = "audio/pcm;rate=24000;channels=1";
const samples = (count: number) => new Uint8Array(count * 2);

describe("pcmRate", () => {
  test("reads the sample rate from a raw PCM content type", () => {
    expect(pcmRate("audio/pcm;rate=24000;channels=1")).toBe(24000);
    expect(pcmRate("audio/pcm; rate=16000")).toBe(16000);
  });

  test("is null for any other audio type or a missing rate", () => {
    expect(pcmRate("audio/mpeg")).toBeNull();
    expect(pcmRate("audio/wav")).toBeNull();
    expect(pcmRate("audio/pcm")).toBeNull();
    expect(pcmRate("audio/pcm;rate=0")).toBeNull();
  });
});

describe("pcm16ToFloat32", () => {
  test("turns 16-bit little-endian samples into floats between -1 and 1", () => {
    const out = pcm16ToFloat32(new Uint8Array([0x00, 0x80, 0xff, 0x7f, 0, 0]));
    expect(out[0]).toBe(-1);
    expect(out[1]).toBe(Math.fround(32767 / 32768));
    expect(out[2]).toBe(0);
  });
});

describe("createAudioPlayer", () => {
  test("plays PCM chunks in order, back to back, at the rate the type names", async () => {
    const fake = fakeContext();
    const player = createAudioPlayer(fake.context);
    await player.play(
      PCM,
      streamOf([samples(2400), samples(4800), samples(1200)]),
    );
    expect(fake.sources.map((s) => s.buffer.sampleRate)).toEqual([
      24000, 24000, 24000,
    ]);
    expect(fake.sources.map((s) => s.buffer.samples.length)).toEqual([
      2400, 4800, 1200,
    ]);
    const when = fake.sources.map((s) => s.when);
    expect(when[0]).toBe(0);
    expect(when.map((value) => Math.round(value * 1000) / 1000)).toEqual([0, 0.1, 0.3]);
  });

  test("carries an odd byte into the next chunk instead of dropping it", async () => {
    const fake = fakeContext();
    const player = createAudioPlayer(fake.context);
    await player.play(
      PCM,
      streamOf([new Uint8Array([0x00]), new Uint8Array([0x80, 0xff, 0x7f])]),
    );
    const all = fake.sources.flatMap((s) => [...s.buffer.samples]);
    expect(all).toHaveLength(2);
    expect(all[0]).toBe(-1);
  });

  test("schedules the next clip right after the one before it", async () => {
    const fake = fakeContext();
    const player = createAudioPlayer(fake.context);
    await player.play(PCM, streamOf([samples(2400)]));
    await player.play(PCM, streamOf([samples(2400)]));
    expect(fake.sources.map((s) => s.when)).toEqual([0, 0.1]);
  });

  test("never schedules in the past when playback had already caught up", async () => {
    const fake = fakeContext();
    const player = createAudioPlayer(fake.context);
    await player.play(PCM, streamOf([samples(2400)]));
    fake.raw.currentTime = 5;
    await player.play(PCM, streamOf([samples(2400)]));
    expect(fake.sources[1].when).toBe(5);
  });

  test("decodes any other audio type whole and plays it", async () => {
    const fake = fakeContext();
    const player = createAudioPlayer(fake.context);
    await player.play(
      "audio/mpeg",
      streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]),
    );
    expect(new Uint8Array(fake.decoded[0])).toEqual(new Uint8Array([1, 2, 3]));
    expect(fake.sources).toHaveLength(1);
    expect(fake.sources[0].buffer.sampleRate).toBe(48000);
  });

  test("decodes the WAV the local server returns for mittr speech", async () => {
    const fake = fakeContext();
    const player = createAudioPlayer(fake.context);
    await player.play("audio/wav", streamOf([new Uint8Array([82, 73, 70, 70])]));
    expect(fake.decoded).toHaveLength(1);
    expect(fake.sources).toHaveLength(1);
  });

  test("reports when everything scheduled has finished playing", async () => {
    const fake = fakeContext();
    const player = createAudioPlayer(fake.context);
    await player.play(PCM, streamOf([samples(2400), samples(2400)]));
    let drained = false;
    const done = player.drained().then(() => {
      drained = true;
    });
    expect(player.busy).toBe(true);
    fake.sources[0].end();
    await Promise.resolve();
    expect(drained).toBe(false);
    fake.sources[1].end();
    await done;
    expect(player.busy).toBe(false);
  });

  test("stop() halts at once, clears the queue and ignores what is still arriving", async () => {
    const fake = fakeContext();
    const player = createAudioPlayer(fake.context);
    const wire = manualStream();
    const playing = player.play(PCM, wire.body);
    wire.push(samples(2400));
    wire.push(samples(2400));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.sources).toHaveLength(2);
    const drained = player.drained();
    player.stop();
    expect(fake.sources.every((s) => s.stopped)).toBe(true);
    await drained;
    await playing;
    expect(player.busy).toBe(false);
    fake.raw.currentTime = 0.05;
    await player.play(PCM, streamOf([samples(2400)]));
    expect(fake.sources).toHaveLength(3);
    expect(fake.sources[2].when).toBe(0.05);
  });

  test("a chunk that was already on its way when stop() came is never scheduled", async () => {
    const fake = fakeContext();
    const player = createAudioPlayer(fake.context);
    const wire = manualStream();
    const playing = player.play(PCM, wire.body);
    await new Promise((resolve) => setTimeout(resolve, 0));
    wire.push(samples(2400));
    player.stop();
    await playing;
    expect(fake.sources).toHaveLength(0);
    expect(player.busy).toBe(false);
  });

  test("a whole clip still decoding when stop() came is never scheduled", async () => {
    const fake = fakeContext();
    let release!: () => void;
    const decoding = new Promise<void>((resolve) => {
      release = resolve;
    });
    const decode = fake.raw.decodeAudioData;
    fake.raw.decodeAudioData = async (data: ArrayBuffer) => {
      await decoding;
      return decode(data);
    };
    const player = createAudioPlayer(fake.context);
    const playing = player.play("audio/mpeg", streamOf([new Uint8Array([1])]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    player.stop();
    release();
    await playing;
    expect(fake.sources).toHaveLength(0);
  });

  test("drained() resolves at once when nothing is playing", async () => {
    const player = createAudioPlayer(fakeContext().context);
    expect(await player.drained()).toBe(undefined);
  });
});
