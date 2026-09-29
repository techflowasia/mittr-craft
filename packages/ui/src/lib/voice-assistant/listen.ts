export type ListenFailure = 'mic_denied' | 'no_mic';

export class ListenError extends Error {
  constructor(readonly reason: ListenFailure) {
    super(reason);
    this.name = 'ListenError';
  }
}

export const VAD_ASSET_PATH = '/vad/';

export interface ConversationListenOptions {
  silenceMs: number;
  onSpeechStart(): void;
  onSpeechConfirmed(): void;
  onMisfire(): void;
  onSpeechEnd(samples: Float32Array): void;
}

export interface ConversationListenHandle {
  destroy(): void;
}

export type StartConversationListening = (options: ConversationListenOptions) => Promise<ConversationListenHandle>;

const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    channelCount: 1,
    echoCancellation: true,
    autoGainControl: true,
    noiseSuppression: true,
  },
};

function reasonOf(error: unknown): ListenFailure | null {
  const name = error instanceof Error || error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'mic_denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no_mic';
  return null;
}

function release(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export const startConversationListening: StartConversationListening = async (options) => {
  const { MicVAD } = await import('@ricky0123/vad-web');
  let open = true;
  const captured: { stream: MediaStream | null } = { stream: null };
  let detector: { destroy: () => Promise<void> };
  try {
    detector = await MicVAD.new({
      model: 'v5',
      baseAssetPath: VAD_ASSET_PATH,
      onnxWASMBasePath: VAD_ASSET_PATH,
      redemptionMs: options.silenceMs,
      submitUserSpeechOnPause: false,
      startOnLoad: true,
      getStream: async () => {
        captured.stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
        return captured.stream;
      },
      onSpeechStart: () => {
        if (open) options.onSpeechStart();
      },
      onSpeechRealStart: () => {
        if (open) options.onSpeechConfirmed();
      },
      onVADMisfire: () => {
        if (open) options.onMisfire();
      },
      onSpeechEnd: (audio: Float32Array) => {
        if (open) options.onSpeechEnd(audio);
      },
    });
  } catch (error: unknown) {
    release(captured.stream);
    const reason = reasonOf(error);
    if (reason) throw new ListenError(reason);
    throw error;
  }
  return {
    destroy: () => {
      if (!open) return;
      open = false;
      void detector.destroy().catch(() => {});
      release(captured.stream);
    },
  };
};

export function encodeWav(samples: Float32Array, sampleRate = 16000): Blob {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
