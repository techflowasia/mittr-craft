import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

import { pcm16ToWav } from './audio.js';

const MITTR_SAMPLE_RATE = 16000;

export class MittrTranscriptionSession extends EventEmitter {
  constructor({ client }) {
    super();
    this.client = client;
    this.requiredSampleRate = MITTR_SAMPLE_RATE;
    this.connected = false;
    this.segmentId = randomUUID();
    this.previousSegmentId = null;
    this.pcm16 = Buffer.alloc(0);
    this.inFlight = new AbortController();
  }

  async connect() {
    if (!this.client) {
      throw new Error('The Mittr platform is not available on this install');
    }
    this.connected = true;
  }

  appendPcm16(chunk) {
    if (!this.connected) {
      this.emit('error', new Error('STT session not connected'));
      return;
    }
    this.pcm16 = this.pcm16.length === 0 ? chunk : Buffer.concat([this.pcm16, chunk]);
  }

  commit() {
    if (!this.connected) {
      this.emit('error', new Error('STT session not connected'));
      return;
    }

    const committedId = this.segmentId;
    const previousSegmentId = this.previousSegmentId;
    const committedPcm16 = this.pcm16;
    this.previousSegmentId = committedId;
    this.segmentId = randomUUID();
    this.pcm16 = Buffer.alloc(0);
    this.emit('committed', { segmentId: committedId, previousSegmentId });

    const signal = this.inFlight.signal;
    void (async () => {
      try {
        const text = await this.client.transcribe(pcm16ToWav(committedPcm16, MITTR_SAMPLE_RATE), signal);
        if (signal.aborted) return;
        this.emit('transcript', {
          segmentId: committedId,
          transcript: (text ?? '').trim(),
          isFinal: true,
        });
      } catch (err) {
        if (signal.aborted) return;
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    })();
  }

  clear() {
    this.pcm16 = Buffer.alloc(0);
    this.segmentId = randomUUID();
  }

  close() {
    this.connected = false;
    this.pcm16 = Buffer.alloc(0);
    this.inFlight.abort();
  }
}
