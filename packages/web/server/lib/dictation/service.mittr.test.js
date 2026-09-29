import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDictationService } from './service.js';
import { MittrTranscriptionSession } from './mittr-session.js';

const readyReadiness = {
  signedIn: true,
  ready: { listen: true, speak: true, voice: true },
  reason: null,
};

describe('dictation service with the Mittr provider', () => {
  let modelsDir;
  let service;

  beforeEach(async () => {
    modelsDir = await mkdtemp(path.join(os.tmpdir(), 'mittr-dictation-'));
  });

  afterEach(async () => {
    service?.shutdown();
    await rm(modelsDir, { recursive: true, force: true });
  });

  const withClient = (client) => {
    service = createDictationService({ modelsDir, getMittrSpeechClient: () => client });
    return service;
  };

  it('opens a Mittr session when listening is ready', async () => {
    const client = { readiness: vi.fn(async () => readyReadiness), transcribe: vi.fn(async () => 'hi') };
    const result = await withClient(client).createSttSession({ provider: 'mittr' });
    expect(result.session).toBeInstanceOf(MittrTranscriptionSession);
    expect(result.session.requiredSampleRate).toBe(16000);
  });

  it('carries the readiness reason when the person is not signed in', async () => {
    const client = {
      readiness: vi.fn(async () => ({ signedIn: false, ready: { listen: false, speak: false, voice: false }, reason: 'not_signed_in' })),
      transcribe: vi.fn(),
    };
    const result = await withClient(client).createSttSession({ provider: 'mittr' });
    expect(result).toMatchObject({ retryable: true, reasonCode: 'not_signed_in' });
    expect(typeof result.error).toBe('string');
  });

  it('says not_configured when listening is not pinned even if speaking is', async () => {
    const client = {
      readiness: vi.fn(async () => ({ signedIn: true, ready: { listen: false, speak: true, voice: true }, reason: 'not_configured' })),
      transcribe: vi.fn(),
    };
    const result = await withClient(client).createSttSession({ provider: 'mittr' });
    expect(result).toMatchObject({ retryable: false, reasonCode: 'not_configured' });
  });

  it('says unreachable when this install has no platform', async () => {
    const result = await withClient(null).createSttSession({ provider: 'mittr' });
    expect(result).toMatchObject({ reasonCode: 'unreachable' });
  });

  it('reports status from readiness with the reason', async () => {
    const client = {
      readiness: vi.fn(async () => ({ signedIn: true, ready: { listen: false, speak: true, voice: false }, reason: 'not_configured' })),
    };
    const status = await withClient(client).getStatus({ provider: 'mittr' });
    expect(status).toMatchObject({ provider: 'mittr', available: false, reasonCode: 'not_configured' });
    expect(Array.isArray(status.models)).toBe(true);
  });

  it('reports available when listening is ready, whatever the voice assistant needs', async () => {
    const client = {
      readiness: vi.fn(async () => ({ signedIn: true, ready: { listen: true, speak: false, voice: false }, reason: 'not_configured' })),
    };
    const status = await withClient(client).getStatus({ provider: 'mittr' });
    expect(status).toMatchObject({ provider: 'mittr', available: true });
    expect(status.reasonCode).toBeUndefined();
  });

  it('keeps unknown providers on the local default', async () => {
    const status = await withClient(null).getStatus({ provider: 'nonsense' });
    expect(status.provider).toBe('local');
  });
});
