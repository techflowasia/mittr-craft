export type AudioOut = Pick<
  BaseAudioContext,
  | "currentTime"
  | "destination"
  | "createBuffer"
  | "createBufferSource"
  | "decodeAudioData"
>;

export interface AudioPlayer {
  play(contentType: string, body: ReadableStream<Uint8Array>): Promise<void>;
  drained(): Promise<void>;
  stop(): void;
  readonly busy: boolean;
}

export function pcmRate(contentType: string): number | null {
  const [type, ...params] = contentType.split(";").map((part) => part.trim());
  if (type.toLowerCase() !== "audio/pcm") return null;
  for (const param of params) {
    const [key, value] = param.split("=").map((part) => part.trim());
    if (key.toLowerCase() !== "rate") continue;
    const rate = Number(value);
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  }
  return null;
}

export function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
  const count = Math.floor(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

function joined(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export function createAudioPlayer(context: AudioOut): AudioPlayer {
  let generation = 0;
  let nextStart = 0;
  const feeds = new Set<object>();
  const sources = new Set<AudioBufferSourceNode>();
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  let waiters: (() => void)[] = [];

  const busy = () => sources.size > 0 || feeds.size > 0;

  const settle = () => {
    if (busy()) return;
    const release = waiters;
    waiters = [];
    for (const resolve of release) resolve();
  };

  const schedule = (buffer: AudioBuffer) => {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => {
      sources.delete(source);
      settle();
    };
    const when = Math.max(context.currentTime, nextStart);
    sources.add(source);
    source.start(when);
    nextStart = when + buffer.duration;
  };

  const schedulePcm = (samples: Float32Array, rate: number) => {
    if (!samples.length) return;
    const buffer = context.createBuffer(1, samples.length, rate);
    buffer.getChannelData(0).set(samples);
    schedule(buffer);
  };

  return {
    get busy() {
      return busy();
    },
    async play(contentType, body) {
      const mine = generation;
      const reader = body.getReader();
      const feed = {};
      readers.add(reader);
      feeds.add(feed);
      const rate = pcmRate(contentType);
      const whole: Uint8Array[] = [];
      let carry: Uint8Array | null = null;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (mine !== generation) return;
          if (done) break;
          if (rate === null) {
            whole.push(value);
            continue;
          }
          const bytes: Uint8Array = carry ? joined([carry, value]) : value;
          const even = bytes.length - (bytes.length % 2);
          carry = even < bytes.length ? bytes.slice(even) : null;
          schedulePcm(pcm16ToFloat32(bytes.subarray(0, even)), rate);
        }
        if (rate === null && whole.length) {
          const data = joined(whole);
          const buffer = await context.decodeAudioData(
            data.buffer.slice(
              data.byteOffset,
              data.byteOffset + data.byteLength,
            ) as ArrayBuffer,
          );
          if (mine !== generation) return;
          schedule(buffer);
        }
      } catch (error: unknown) {
        if (mine !== generation) return;
        throw error;
      } finally {
        readers.delete(reader);
        feeds.delete(feed);
        settle();
      }
    },
    drained() {
      if (!busy()) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
    stop() {
      generation += 1;
      nextStart = 0;
      for (const reader of readers) void reader.cancel().catch(() => {});
      readers.clear();
      const playing = [...sources];
      sources.clear();
      for (const source of playing) {
        source.onended = null;
        try {
          source.stop();
        } catch {
          continue;
        }
      }
      feeds.clear();
      settle();
    },
  };
}
