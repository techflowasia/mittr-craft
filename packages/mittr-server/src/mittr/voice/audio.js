export const PCM_DEFAULT_RATE = 24_000;
export const SPEECH_TEXT_MAX_CHARS = 4000;

const PCM_TYPES = new Map([['audio/pcm', false], ['audio/l16', true]]);
const SENTENCE_END = /[.!?…。\n]/u;
const WHITESPACE = /\s/u;

const parameterOf = (contentType, name) => {
  const match = new RegExp(`(?:^|[;,\\s])${name}\\s*=\\s*(\\d+)`, 'i').exec(contentType);
  const value = match ? Number.parseInt(match[1], 10) : Number.NaN;
  return Number.isInteger(value) && value > 0 ? value : null;
};

export const pcm16ToWav = (pcm, rate) => {
  const channels = 1;
  const bitsPerSample = 16;
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE((rate * channels * bitsPerSample) / 8, 28);
  wav.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
};

export const pcmFormatOf = (contentType) => {
  const type = String(contentType ?? '');
  const mediaType = type.split(';')[0].trim().toLowerCase();
  if (!PCM_TYPES.has(mediaType)) return null;
  return {
    rate: parameterOf(type, 'rate') ?? PCM_DEFAULT_RATE,
    channels: parameterOf(type, 'channels') ?? 1,
    swap: PCM_TYPES.get(mediaType),
  };
};

const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;

export const clampSpeech = (text, max) => (text.length <= max ? text : text.slice(0, isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max));

const cutOf = (text, max) => {
  const limit = isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
  for (let index = limit - 1; index > 0; index -= 1) {
    if (SENTENCE_END.test(text[index])) return { end: index + 1, next: index + 1 };
  }
  for (let index = limit - 1; index > 0; index -= 1) {
    if (WHITESPACE.test(text[index])) return { end: index, next: index + 1 };
  }
  return { end: limit, next: limit };
};

export const splitSpeechText = (text, max = SPEECH_TEXT_MAX_CHARS) => {
  const parts = [];
  let rest = String(text ?? '').trim();
  while (rest.length > max) {
    const { end, next } = cutOf(rest, max);
    const part = rest.slice(0, end).trim();
    if (part) parts.push(part);
    rest = rest.slice(next).trim();
  }
  if (rest) parts.push(rest);
  return parts;
};
