import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { registerVoiceSpeechRoutes } from './routes.js';

const createApp = (client) => {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));
  registerVoiceSpeechRoutes(app, { express, getMittrSpeechClient: () => client });
  return app;
};

const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(40), Buffer.from([1, 0, 2, 0])]);

const speechError = (reasonCode, statusCode) => Object.assign(new Error(`Mittr speech failed: ${reasonCode}`), { reasonCode, statusCode });

describe('GET /api/voice/readiness', () => {
  it('answers the wire shape when everything is ready', async () => {
    const client = {
      readiness: vi.fn(async () => ({
        signedIn: true,
        ready: { listen: true, speak: true, voice: true },
        silenceMs: 1500,
        voiceSilenceMs: 900,
        reason: null,
      })),
    };
    const response = await request(createApp(client)).get('/api/voice/readiness');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      listen: true,
      speak: true,
      voice: true,
      signedIn: true,
      voiceSilenceMs: 900,
      reason: null,
    });
  });

  it('carries the reason when the person is not signed in', async () => {
    const client = {
      readiness: vi.fn(async () => ({ signedIn: false, ready: { listen: false, speak: false, voice: false }, reason: 'not_signed_in' })),
    };
    const response = await request(createApp(client)).get('/api/voice/readiness');
    expect(response.body).toEqual({
      listen: false,
      speak: false,
      voice: false,
      signedIn: false,
      voiceSilenceMs: null,
      reason: 'not_signed_in',
    });
  });

  it('says unreachable when this install has no platform', async () => {
    const response = await request(createApp(null)).get('/api/voice/readiness');
    expect(response.body).toMatchObject({ listen: false, speak: false, voice: false, signedIn: false, reason: 'unreachable' });
  });
});

describe('POST /api/voice/transcribe', () => {
  it('sends the uploaded audio to the platform and answers the text', async () => {
    const client = { transcribe: vi.fn(async () => 'เปิดเว็บ') };
    const response = await request(createApp(client))
      .post('/api/voice/transcribe')
      .attach('audio', wav, { filename: 'speech.wav', contentType: 'audio/wav' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ text: 'เปิดเว็บ' });
    const [sent, signal] = client.transcribe.mock.calls[0];
    expect(Buffer.from(sent)).toEqual(wav);
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('answers the reason and status the platform gave', async () => {
    const client = { transcribe: vi.fn(async () => { throw speechError('upstream_timeout', 504); }) };
    const response = await request(createApp(client))
      .post('/api/voice/transcribe')
      .attach('audio', wav, { filename: 'speech.wav', contentType: 'audio/wav' });
    expect(response.status).toBe(504);
    expect(response.body).toMatchObject({ reasonCode: 'upstream_timeout' });
    expect(typeof response.body.error).toBe('string');
  });

  it('answers the weekly quota refusal with its reset time', async () => {
    const quota = Object.assign(speechError('llm_quota_exhausted', 429), { quotaKind: 'stt', resetsAt: '2026-10-04T17:00:00.000Z' });
    const client = { transcribe: vi.fn(async () => { throw quota; }) };
    const response = await request(createApp(client))
      .post('/api/voice/transcribe')
      .attach('audio', wav, { filename: 'speech.wav', contentType: 'audio/wav' });
    expect(response.status).toBe(429);
    expect(response.body).toMatchObject({ reasonCode: 'llm_quota_exhausted', resetsAt: '2026-10-04T17:00:00.000Z' });
  });

  it('answers 401 not_signed_in without a session', async () => {
    const client = { transcribe: vi.fn(async () => { throw speechError('not_signed_in', 401); }) };
    const response = await request(createApp(client))
      .post('/api/voice/transcribe')
      .attach('audio', wav, { filename: 'speech.wav', contentType: 'audio/wav' });
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ reasonCode: 'not_signed_in' });
  });

  it('refuses a request without the audio field', async () => {
    const client = { transcribe: vi.fn() };
    const response = await request(createApp(client))
      .post('/api/voice/transcribe')
      .field('other', 'x');
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ reasonCode: 'bad_request' });
    expect(client.transcribe).not.toHaveBeenCalled();
  });

  it('refuses a body that is not multipart', async () => {
    const client = { transcribe: vi.fn() };
    const response = await request(createApp(client))
      .post('/api/voice/transcribe')
      .set('content-type', 'audio/wav')
      .send(wav);
    expect(response.status).toBe(400);
    expect(client.transcribe).not.toHaveBeenCalled();
  });

  it('says unreachable when this install has no platform', async () => {
    const response = await request(createApp(null))
      .post('/api/voice/transcribe')
      .attach('audio', wav, { filename: 'speech.wav', contentType: 'audio/wav' });
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ reasonCode: 'unreachable' });
  });
});
