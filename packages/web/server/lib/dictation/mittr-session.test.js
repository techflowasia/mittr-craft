import { describe, expect, it, vi } from 'vitest';

import { MittrTranscriptionSession } from './mittr-session.js';

const nextEvent = (session, name) => new Promise((resolve) => session.once(name, resolve));

const connected = async (transcribe) => {
  const client = { transcribe: vi.fn(transcribe) };
  const session = new MittrTranscriptionSession({ client });
  await session.connect();
  return { client, session };
};

describe('MittrTranscriptionSession', () => {
  it('asks for 16 kHz audio', () => {
    expect(new MittrTranscriptionSession({ client: { transcribe: vi.fn() } }).requiredSampleRate).toBe(16000);
  });

  it('refuses to connect without a client', async () => {
    await expect(new MittrTranscriptionSession({ client: null }).connect()).rejects.toThrow();
  });

  it('sends each committed segment as a 16 kHz WAV and emits its transcript', async () => {
    const { client, session } = await connected(async () => '  hello there ');
    const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
    session.appendPcm16(pcm.subarray(0, 4));
    session.appendPcm16(pcm.subarray(4));

    const committed = nextEvent(session, 'committed');
    const transcript = nextEvent(session, 'transcript');
    session.commit();

    const { segmentId, previousSegmentId } = await committed;
    expect(previousSegmentId).toBeNull();
    expect(await transcript).toEqual({ segmentId, transcript: 'hello there', isFinal: true });

    const wav = client.transcribe.mock.calls[0][0];
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.subarray(44)).toEqual(pcm);
  });

  it('starts every segment empty and links it to the one before', async () => {
    const { client, session } = await connected(async () => 'x');
    session.appendPcm16(Buffer.from([1, 0]));
    const first = nextEvent(session, 'committed');
    session.commit();
    const { segmentId: firstId } = await first;

    session.appendPcm16(Buffer.from([2, 0]));
    const second = nextEvent(session, 'committed');
    session.commit();
    const { previousSegmentId } = await second;

    expect(previousSegmentId).toBe(firstId);
    await vi.waitFor(() => expect(client.transcribe).toHaveBeenCalledTimes(2));
    expect(client.transcribe.mock.calls[1][0].subarray(44)).toEqual(Buffer.from([2, 0]));
  });

  it('emits an error carrying the reason when the platform fails', async () => {
    const failure = Object.assign(new Error('Mittr speech failed: upstream_failed'), { reasonCode: 'upstream_failed' });
    const { session } = await connected(async () => {
      throw failure;
    });
    session.appendPcm16(Buffer.from([1, 0]));
    const error = nextEvent(session, 'error');
    session.commit();
    await expect(error).resolves.toMatchObject({ reasonCode: 'upstream_failed' });
  });

  it('turns an expired session into the sign-in message and stops retrying', async () => {
    const { session } = await connected(async () => {
      throw Object.assign(new Error('Mittr speech failed: not_signed_in'), { reasonCode: 'not_signed_in', statusCode: 401 });
    });
    session.appendPcm16(Buffer.from([1, 0]));
    const error = nextEvent(session, 'error');
    session.commit();
    await expect(error).resolves.toMatchObject({
      message: 'Sign in to Mittr to use dictation',
      reasonCode: 'not_signed_in',
      retryable: false,
    });
  });

  it('keeps a platform failure retryable with its reason', async () => {
    const { session } = await connected(async () => {
      throw Object.assign(new Error('Mittr speech failed: upstream_timeout'), { reasonCode: 'upstream_timeout', statusCode: 504 });
    });
    session.appendPcm16(Buffer.from([1, 0]));
    const error = nextEvent(session, 'error');
    session.commit();
    await expect(error).resolves.toMatchObject({ reasonCode: 'upstream_timeout', retryable: true });
  });

  it('errors when audio arrives before connect', () => {
    const session = new MittrTranscriptionSession({ client: { transcribe: vi.fn() } });
    const onError = vi.fn();
    session.on('error', onError);
    session.appendPcm16(Buffer.from([1, 0]));
    session.commit();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('aborts an in-flight transcription on close and drops its result', async () => {
    let seenSignal;
    const { session } = await connected((_wav, signal) => {
      seenSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason));
      });
    });
    const onTranscript = vi.fn();
    const onError = vi.fn();
    session.on('transcript', onTranscript);
    session.on('error', onError);
    session.appendPcm16(Buffer.from([1, 0]));
    session.commit();
    await vi.waitFor(() => expect(seenSignal).toBeDefined());
    session.close();
    await vi.waitFor(() => expect(seenSignal.aborted).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onTranscript).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
