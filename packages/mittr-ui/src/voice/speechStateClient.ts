import { z } from 'zod';

import { speechQuotaStore, type SpeechQuotaKind } from './speechQuotaStore';
import type { VoiceFetch } from './voiceApi';

export const SPEECH_STATE_ENDPOINT = '/api/mittr/speech/state';
export const SPEECH_STATE_RETRY_MS = 5_000;

const blockedUntil = z.string().refine((value) => !Number.isNaN(Date.parse(value))).nullable();

const viewSchema = z.object({
  revision: z.number().int().nonnegative(),
  stt: z.object({ blockedUntil }),
  tts: z.object({ blockedUntil }),
});

export type SpeechStateView = z.infer<typeof viewSchema>;

export type SpeechBlocks = {
  block: (kind: SpeechQuotaKind, resetsAt: string | null) => string;
  clear: (kind: SpeechQuotaKind) => void;
};

export type Wait = (ms: number, signal: AbortSignal) => Promise<void>;

export interface SpeechStateClientDeps {
  fetch: VoiceFetch;
  blocks?: SpeechBlocks;
  wait?: Wait;
  retryMs?: number;
}

const waitFor: Wait = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(done, ms);
  function done() {
    clearTimeout(timer);
    signal.removeEventListener('abort', done);
    resolve();
  }
  signal.addEventListener('abort', done);
});

export function applySpeechState(view: SpeechStateView, blocks: SpeechBlocks): void {
  for (const kind of ['stt', 'tts'] as const) {
    const until = view[kind].blockedUntil;
    if (until) blocks.block(kind, until);
    else blocks.clear(kind);
  }
}

async function readView(deps: SpeechStateClientDeps, since: number | null, signal: AbortSignal): Promise<SpeechStateView | null> {
  const path = since === null ? SPEECH_STATE_ENDPOINT : `${SPEECH_STATE_ENDPOINT}?since=${since}`;
  try {
    const res = await deps.fetch(path, { method: 'GET', signal });
    if (!res.ok) return null;
    const parsed = viewSchema.safeParse(await res.json().catch(() => null));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function startSpeechStateClient(deps: SpeechStateClientDeps): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  const blocks = deps.blocks ?? speechQuotaStore;
  const wait = deps.wait ?? waitFor;
  const retryMs = deps.retryMs ?? SPEECH_STATE_RETRY_MS;
  void (async () => {
    let since: number | null = null;
    while (!signal.aborted) {
      const view = await readView(deps, since, signal);
      if (signal.aborted) return;
      if (!view) {
        await wait(retryMs, signal);
        continue;
      }
      const changed = view.revision !== since;
      if (changed) applySpeechState(view, blocks);
      since = view.revision;
      if (!changed) await wait(retryMs, signal);
    }
  })();
  return () => controller.abort();
}
