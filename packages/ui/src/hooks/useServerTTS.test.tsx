import React from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

const configState = {
  currentProviderId: 'mittr',
  currentModelId: 'mittr-model',
  openaiApiKey: 'sk-test',
  openaiCompatibleUrl: 'http://localhost:8880/v1',
  openaiCompatibleApiKey: '',
};

const requests: Array<{ path: string; body: Record<string, unknown> }> = [];

mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: (selector: (state: typeof configState) => unknown) => selector(configState),
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (path: string, init?: RequestInit) => {
    requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : {} });
    return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': 'audio/mpeg' } });
  },
}));

class FakeAudioContext {
  state = 'running';
  destination = {};
  async resume() {}
  createBuffer() {
    return {};
  }
  createBufferSource() {
    return { buffer: null, connect: () => {}, start: () => {}, stop: () => {}, detune: { value: 0 }, onended: null };
  }
  createGain() {
    return { gain: { value: 1 }, connect: () => {} };
  }
  async decodeAudioData() {
    return {};
  }
}

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  writable: true,
  value: { AudioContext: FakeAudioContext },
});

const { useServerTTS } = await import('./useServerTTS');

const captureSpeak = () => {
  let speak: ReturnType<typeof useServerTTS>['speak'] | null = null;
  const Probe = () => {
    speak = useServerTTS({ enabled: false }).speak;
    return null;
  };
  renderToStaticMarkup(<Probe />);
  if (!speak) throw new Error('hook did not render');
  return speak as ReturnType<typeof useServerTTS>['speak'];
};

beforeEach(() => {
  requests.length = 0;
});

describe('useServerTTS request body', () => {
  test('the OpenAI path never names the chat provider, even when it is Mittr', async () => {
    await captureSpeak()('hello', { voice: 'nova' });
    const speakRequest = requests.find((request) => request.path === '/api/tts/speak');
    expect(speakRequest).toBeDefined();
    expect('providerId' in (speakRequest?.body ?? {}) && speakRequest?.body.providerId !== undefined).toBe(false);
    expect(speakRequest?.body.modelId).toBe(undefined);
  });

  test('the OpenAI-compatible path never names the chat provider either', async () => {
    await captureSpeak()('hello', { voice: 'af_sky', baseURL: 'http://localhost:8880/v1' });
    const speakRequest = requests.find((request) => request.path === '/api/tts/speak');
    expect(speakRequest?.body.providerId).toBe(undefined);
    expect(speakRequest?.body.baseURL).toBe('http://localhost:8880/v1');
  });

  test('Mittr is named only when the caller asks for it', async () => {
    await captureSpeak()('hello', { providerId: 'mittr' });
    const speakRequest = requests.find((request) => request.path === '/api/tts/speak');
    expect(speakRequest?.body.providerId).toBe('mittr');
  });
});
