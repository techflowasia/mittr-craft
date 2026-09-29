import { describe, expect, it, vi } from 'vitest';

import { createMittrSpeechClient } from './client.js';

const session = { accessToken: 'token-1' };

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

const readyBody = {
  listen: { ready: true },
  speak: { ready: true },
  voice: { ready: true },
  silenceMs: 1500,
  startWaitMs: 6000,
  voiceSilenceMs: 900,
};

const clientWith = (responder, { ensureFreshSession = async () => session, now } = {}) => {
  const fetchImpl = vi.fn(async (...args) => (typeof responder === 'function' ? responder(...args) : responder));
  const client = createMittrSpeechClient({
    brokerBaseUrl: 'https://api.example/',
    ensureFreshSession,
    fetchImpl,
    ...(now ? { now } : {}),
  });
  return { client, fetchImpl };
};

describe('createMittrSpeechClient', () => {
  it('is absent when this install has no platform to call', () => {
    expect(createMittrSpeechClient({ ensureFreshSession: async () => session })).toBeNull();
    expect(createMittrSpeechClient({ brokerBaseUrl: 'https://api.example/' })).toBeNull();
  });

  describe('readiness', () => {
    it('reads the platform readiness with the desktop session', async () => {
      const { client, fetchImpl } = clientWith(() => json(readyBody));
      const readiness = await client.readiness();
      expect(readiness).toEqual({
        signedIn: true,
        ready: { listen: true, speak: true, voice: true },
        silenceMs: 1500,
        voiceSilenceMs: 900,
        reason: null,
      });
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe('https://api.example/desktop/speech/readiness');
      expect(init.headers.Authorization).toBe('Bearer token-1');
    });

    it('says not_signed_in without calling the platform when there is no session', async () => {
      const { client, fetchImpl } = clientWith(() => json(readyBody), { ensureFreshSession: async () => null });
      const readiness = await client.readiness();
      expect(readiness).toMatchObject({
        signedIn: false,
        ready: { listen: false, speak: false, voice: false },
        reason: 'not_signed_in',
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('says not_signed_in when the platform refuses the desktop session', async () => {
      const { client } = clientWith(() => json({ message: 'desktop_session_required' }, 403));
      expect(await client.readiness()).toMatchObject({ signedIn: false, reason: 'not_signed_in' });
    });

    it('says not_configured when any speech part is not pinned', async () => {
      const { client } = clientWith(() => json({ ...readyBody, voice: { ready: false } }));
      expect(await client.readiness()).toMatchObject({
        signedIn: true,
        ready: { listen: true, speak: true, voice: false },
        reason: 'not_configured',
      });
    });

    it('says not_configured when the platform answers with that code', async () => {
      const { client } = clientWith(() => json({ code: 'not_configured' }, 503));
      expect(await client.readiness()).toMatchObject({
        signedIn: true,
        ready: { listen: false, speak: false, voice: false },
        reason: 'not_configured',
      });
    });

    it('says unreachable when the platform cannot be reached', async () => {
      const { client } = clientWith(() => {
        throw new TypeError('fetch failed');
      });
      expect(await client.readiness()).toMatchObject({
        signedIn: true,
        ready: { listen: false, speak: false, voice: false },
        reason: 'unreachable',
      });
    });

    it('keeps a platform answer for 30 seconds for the same session', async () => {
      let clock = 1_000;
      const { client, fetchImpl } = clientWith(() => json(readyBody), { now: () => clock });
      await client.readiness();
      clock += 29_000;
      await client.readiness();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      clock += 2_000;
      await client.readiness();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('asks again when the session changes', async () => {
      let token = 'token-1';
      const { client, fetchImpl } = clientWith(() => json(readyBody), {
        ensureFreshSession: async () => ({ accessToken: token }),
      });
      await client.readiness();
      token = 'token-2';
      await client.readiness();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe('Bearer token-2');
    });

    it('does not keep an unreachable answer', async () => {
      let fail = true;
      const { client, fetchImpl } = clientWith(() => {
        if (fail) throw new TypeError('fetch failed');
        return json(readyBody);
      });
      expect((await client.readiness()).reason).toBe('unreachable');
      fail = false;
      expect((await client.readiness()).reason).toBeNull();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });

  describe('transcribe', () => {
    it('posts the WAV as the multipart audio field with the bearer', async () => {
      const { client, fetchImpl } = clientWith(() => json({ text: ' สวัสดี ', ms: 420 }, 201));
      const wav = Buffer.from('RIFFxxxxWAVE');
      await expect(client.transcribe(wav)).resolves.toBe(' สวัสดี ');
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe('https://api.example/desktop/speech/transcribe');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer token-1');
      expect(init.body).toBeInstanceOf(FormData);
      const file = init.body.get('audio');
      expect(file.type).toBe('audio/wav');
      expect(Buffer.from(await file.arrayBuffer())).toEqual(wav);
    });

    it('treats an empty transcript as no words', async () => {
      const { client } = clientWith(() => json({ code: 'empty_transcript' }, 422));
      await expect(client.transcribe(Buffer.alloc(4))).resolves.toBe('');
    });

    it('maps the platform code to a reasonCode with its status', async () => {
      const { client } = clientWith(() => json({ code: 'upstream_timeout' }, 504));
      await expect(client.transcribe(Buffer.alloc(4))).rejects.toMatchObject({
        reasonCode: 'upstream_timeout',
        statusCode: 504,
      });
    });

    it('refuses with not_signed_in without a session', async () => {
      const { client, fetchImpl } = clientWith(() => json({}), { ensureFreshSession: async () => null });
      await expect(client.transcribe(Buffer.alloc(4))).rejects.toMatchObject({
        reasonCode: 'not_signed_in',
        statusCode: 401,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('maps a refused desktop session to not_signed_in', async () => {
      const { client } = clientWith(() => json({ message: 'desktop_session_required' }, 403));
      await expect(client.transcribe(Buffer.alloc(4))).rejects.toMatchObject({
        reasonCode: 'not_signed_in',
        statusCode: 401,
      });
    });

    it('maps a network failure to unreachable', async () => {
      const { client } = clientWith(() => {
        throw new TypeError('fetch failed');
      });
      await expect(client.transcribe(Buffer.alloc(4))).rejects.toMatchObject({
        reasonCode: 'unreachable',
        statusCode: 502,
      });
    });

    it('passes the caller abort through', async () => {
      const controller = new AbortController();
      const { client, fetchImpl } = clientWith((_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      }));
      const pending = client.transcribe(Buffer.alloc(4), controller.signal);
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });
  });

  describe('synthesize', () => {
    it('posts the text and hands back the upstream body and content type', async () => {
      const { client, fetchImpl } = clientWith(() => new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-type': 'audio/pcm;rate=24000;channels=1' },
      }));
      const result = await client.synthesize('hello');
      expect(result.contentType).toBe('audio/pcm;rate=24000;channels=1');
      expect(Buffer.from(await new Response(result.body).arrayBuffer())).toEqual(Buffer.from([1, 2, 3, 4]));
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe('https://api.example/desktop/speech/synthesize');
      expect(init.headers.Authorization).toBe('Bearer token-1');
      expect(init.headers['content-type']).toBe('application/json');
      expect(JSON.parse(init.body)).toEqual({ text: 'hello' });
    });

    it('maps not_configured from the platform', async () => {
      const { client } = clientWith(() => json({ code: 'not_configured' }, 503));
      await expect(client.synthesize('hello')).rejects.toMatchObject({
        reasonCode: 'not_configured',
        statusCode: 503,
      });
    });

    it('refuses with not_signed_in without a session', async () => {
      const { client } = clientWith(() => json({}), { ensureFreshSession: async () => null });
      await expect(client.synthesize('hello')).rejects.toMatchObject({
        reasonCode: 'not_signed_in',
        statusCode: 401,
      });
    });
  });
});
