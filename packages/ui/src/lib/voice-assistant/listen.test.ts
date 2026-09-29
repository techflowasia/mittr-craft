import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

type VadOptions = {
  redemptionMs: number;
  baseAssetPath: string;
  onnxWASMBasePath: string;
  model: string;
  submitUserSpeechOnPause: boolean;
  startOnLoad: boolean;
  getStream: () => Promise<MediaStream>;
  onSpeechStart: () => void;
  onSpeechRealStart: () => void;
  onSpeechEnd: (audio: Float32Array) => void;
  onVADMisfire: () => void;
};

type Detector = { destroy: () => Promise<void> };

const created = async (options: VadOptions): Promise<Detector> => {
  vad.options = options;
  return { destroy: vad.destroy };
};

const vad = {
  options: null as VadOptions | null,
  destroyed: 0,
  destroy: async () => {
    vad.destroyed += 1;
  },
  create: created,
};

mock.module('@ricky0123/vad-web', () => ({
  MicVAD: { new: (options: VadOptions) => vad.create(options) },
}));

function counter() {
  const fn = () => {
    fn.count += 1;
  };
  fn.count = 0;
  return fn;
}

const { ListenError, VAD_ASSET_PATH, encodeWav, startConversationListening } = await import('./listen');
type ConversationListenOptions = import('./listen').ConversationListenOptions;

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function callbacks() {
  return {
    silenceMs: 900,
    onSpeechStart: counter(),
    onSpeechConfirmed: counter(),
    onMisfire: counter(),
    onSpeechEnd: counter(),
  } satisfies ConversationListenOptions;
}

function micWith(track: { stop: () => void }) {
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: mock(async () => stream) } },
  });
}

beforeEach(() => {
  vad.options = null;
  vad.destroyed = 0;
  vad.create = created;
});

afterEach(() => {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else Reflect.deleteProperty(globalThis, 'navigator');
});

describe('startConversationListening', () => {
  test('ends an utterance after the voice silence and loads its files from the app', async () => {
    await startConversationListening(callbacks());
    expect(VAD_ASSET_PATH).toBe('/vad/');
    const { redemptionMs, baseAssetPath, onnxWASMBasePath, model, submitUserSpeechOnPause, startOnLoad } = vad.options!;
    expect({ redemptionMs, baseAssetPath, onnxWASMBasePath, model, submitUserSpeechOnPause, startOnLoad }).toEqual({
      redemptionMs: 900,
      baseAssetPath: '/vad/',
      onnxWASMBasePath: '/vad/',
      model: 'v5',
      submitUserSpeechOnPause: false,
      startOnLoad: true,
    });
  });

  test('keeps listening after each utterance until destroyed, then goes quiet', async () => {
    const on = callbacks();
    const handle = await startConversationListening(on);
    vad.options!.onSpeechStart();
    vad.options!.onSpeechRealStart();
    vad.options!.onSpeechEnd(new Float32Array([0.1]));
    vad.options!.onSpeechStart();
    vad.options!.onVADMisfire();
    expect(on.onSpeechStart.count).toBe(2);
    expect(on.onSpeechConfirmed.count).toBe(1);
    expect(on.onMisfire.count).toBe(1);
    expect(on.onSpeechEnd.count).toBe(1);
    handle.destroy();
    handle.destroy();
    expect(vad.destroyed).toBe(1);
    vad.options!.onSpeechEnd(new Float32Array([0.3]));
    expect(on.onSpeechEnd.count).toBe(1);
  });

  test('destroy stops the microphone tracks', async () => {
    const track = { stop: counter() };
    micWith(track);
    const handle = await startConversationListening(callbacks());
    await vad.options!.getStream();
    handle.destroy();
    expect(track.stop.count).toBe(1);
  });

  test('stops the microphone tracks when the detector fails to start', async () => {
    const track = { stop: counter() };
    micWith(track);
    vad.create = async (options: VadOptions) => {
      await options.getStream();
      throw new Error('worklet 404');
    };
    await expect(startConversationListening(callbacks())).rejects.toThrow('worklet 404');
    expect(track.stop.count).toBe(1);
  });

  for (const [name, reason] of [
    ['NotAllowedError', 'mic_denied'],
    ['SecurityError', 'mic_denied'],
    ['NotFoundError', 'no_mic'],
    ['OverconstrainedError', 'no_mic'],
  ] as const) {
    test(`${name} from the browser becomes ${reason}`, async () => {
      vad.create = async () => {
        throw new DOMException('x', name);
      };
      const error = await startConversationListening(callbacks()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ListenError);
      expect((error as InstanceType<typeof ListenError>).reason).toBe(reason);
    });
  }
});

describe('encodeWav', () => {
  test('writes a 16 kHz mono 16-bit WAV', async () => {
    const wav = encodeWav(new Float32Array([0, 1, -1]));
    expect(wav.type).toBe('audio/wav');
    const view = new DataView(await wav.arrayBuffer());
    const text = (at: number) => String.fromCharCode(...new Uint8Array(view.buffer, at, 4));
    expect(text(0)).toBe('RIFF');
    expect(text(8)).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(6);
    expect(view.getInt16(46, true)).toBe(0x7fff);
    expect(view.getInt16(48, true)).toBe(-0x8000);
  });
});
