import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { registerTtsRoutes } from './routes.js';

const binaryParser = (res, callback) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

const createApp = (client) => {
  const app = express();
  app.use(express.json());
  registerTtsRoutes(app, { sayTTSCapability: null, getMittrSpeechClient: () => client });
  return app;
};

const speak = (app, body) => request(app)
  .post('/api/tts/speak')
  .send({ providerId: 'mittr', ...body })
  .buffer(true)
  .parse(binaryParser);

const audioReply = (bytes, contentType) => ({
  body: new Response(bytes).body,
  contentType,
});

const speechError = (reasonCode, statusCode) => Object.assign(new Error(`Mittr speech failed: ${reasonCode}`), { reasonCode, statusCode });

describe('POST /api/tts/speak with the Mittr provider', () => {
  it('wraps raw PCM in a WAV header carrying the upstream rate', async () => {
    const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0]);
    const client = { synthesize: vi.fn(async () => audioReply(pcm, 'audio/pcm;rate=24000;channels=1')) };
    const response = await speak(createApp(client), { text: 'hello there' });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('audio/wav');
    const wav = response.body;
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.subarray(44)).toEqual(pcm);
    expect(client.synthesize).toHaveBeenCalledWith('hello there', expect.any(AbortSignal));
  });

  it('uses whatever rate the platform names', async () => {
    const client = { synthesize: vi.fn(async () => audioReply(Buffer.from([1, 0]), 'audio/pcm; rate=16000; channels=1')) };
    const response = await speak(createApp(client), { text: 'hi' });
    expect(response.body.readUInt32LE(24)).toBe(16000);
  });

  it('turns big-endian audio/l16 into little-endian WAV', async () => {
    const l16 = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const client = { synthesize: vi.fn(async () => audioReply(l16, 'audio/L16;rate=16000;channels=1')) };
    const response = await speak(createApp(client), { text: 'hi' });
    expect(response.headers['content-type']).toBe('audio/wav');
    expect(response.body.readUInt32LE(24)).toBe(16000);
    expect(response.body.subarray(44)).toEqual(Buffer.from([0x02, 0x01, 0x04, 0x03]));
  });

  it('drops a trailing odd byte of PCM', async () => {
    const pcm = Buffer.from([1, 0, 2, 0, 9]);
    const client = { synthesize: vi.fn(async () => audioReply(pcm, 'audio/pcm;rate=24000;channels=1')) };
    const response = await speak(createApp(client), { text: 'hi' });
    expect(response.body.readUInt32LE(40)).toBe(4);
    expect(response.body.subarray(44)).toEqual(Buffer.from([1, 0, 2, 0]));
  });

  it('never splits a surrogate pair when cutting long text', async () => {
    const client = { synthesize: vi.fn(async () => audioReply(Buffer.from([1, 0]), 'audio/mpeg')) };
    const long = `${'a'.repeat(3999)}😀${'b'.repeat(100)}`;
    await speak(createApp(client), { text: long });
    const sent = client.synthesize.mock.calls[0][0];
    expect(sent.length).toBeLessThanOrEqual(4000);
    const last = sent.charCodeAt(sent.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  it('passes other audio types through unchanged', async () => {
    const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x44, 0x00]);
    const client = { synthesize: vi.fn(async () => audioReply(mp3, 'audio/mpeg')) };
    const response = await speak(createApp(client), { text: 'hello' });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('audio/mpeg');
    expect(response.body).toEqual(mp3);
  });

  it('answers 401 not_signed_in when there is no Mittr session', async () => {
    const client = { synthesize: vi.fn(async () => { throw speechError('not_signed_in', 401); }) };
    const response = await request(createApp(client)).post('/api/tts/speak').send({ providerId: 'mittr', text: 'hello' });
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ reasonCode: 'not_signed_in' });
    expect(typeof response.body.error).toBe('string');
  });

  it('carries the platform reason and status', async () => {
    const client = { synthesize: vi.fn(async () => { throw speechError('not_configured', 503); }) };
    const response = await request(createApp(client)).post('/api/tts/speak').send({ providerId: 'mittr', text: 'hello' });
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ reasonCode: 'not_configured' });
  });

  it('answers the weekly quota refusal with its reset time', async () => {
    const quota = Object.assign(speechError('llm_quota_exhausted', 429), { quotaKind: 'tts', resetsAt: '2026-10-04T17:00:00.000Z' });
    const client = { synthesize: vi.fn(async () => { throw quota; }) };
    const response = await request(createApp(client)).post('/api/tts/speak').send({ providerId: 'mittr', text: 'hello' });
    expect(response.status).toBe(429);
    expect(response.body).toMatchObject({ reasonCode: 'llm_quota_exhausted', resetsAt: '2026-10-04T17:00:00.000Z' });
  });

  it('says unreachable when this install has no platform', async () => {
    const response = await request(createApp(null)).post('/api/tts/speak').send({ providerId: 'mittr', text: 'hello' });
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ reasonCode: 'unreachable' });
  });

  it('refuses empty text without calling the platform', async () => {
    const client = { synthesize: vi.fn() };
    const response = await request(createApp(client)).post('/api/tts/speak').send({ providerId: 'mittr', text: '   ' });
    expect(response.status).toBe(400);
    expect(client.synthesize).not.toHaveBeenCalled();
  });

  it('keeps text within the platform limit, cut at a word boundary', async () => {
    const client = { synthesize: vi.fn(async () => audioReply(Buffer.from([1, 0]), 'audio/mpeg')) };
    const long = `${'word '.repeat(900)}end`;
    await speak(createApp(client), { text: long });
    const sent = client.synthesize.mock.calls[0][0];
    expect(sent.length).toBeLessThanOrEqual(4000);
    expect(sent.endsWith('word')).toBe(true);
  });

  it('refuses a non-audio reply from the platform', async () => {
    const client = { synthesize: vi.fn(async () => audioReply(Buffer.from('{}'), 'application/json')) };
    const response = await request(createApp(client)).post('/api/tts/speak').send({ providerId: 'mittr', text: 'hello' });
    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({ reasonCode: 'upstream_failed' });
  });
});
