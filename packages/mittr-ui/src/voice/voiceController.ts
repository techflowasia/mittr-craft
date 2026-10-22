import { bindEscapeToEnd } from './keys';
import type { StartConversationListening } from './listen';
import { speechBlockedUntil, speechQuotaStore } from './speechQuotaStore';
import { talkStore } from './talkStore';
import type { FirstRunFacts, FirstRunMark, SpeechOffer, UpstreamSpeech } from './upstreamSpeech';
import { isTalkReady, type VoiceApi, type VoiceQueueEvent, type VoiceReadiness } from './voiceApi';
import { VoiceSession, type VoicePlayback, type VoiceTurnContext } from './voiceSession';

export const READINESS_REFRESH_MS = 60_000;

export type VoiceWindow = EventTarget & Pick<Window, 'setInterval' | 'clearInterval'>;

export type SavedSpeechChoices = Pick<FirstRunFacts, 'vscode' | 'savedSttProvider' | 'savedVoiceProvider' | 'localModelSaved'>;

export interface VoiceControllerDeps {
  api: VoiceApi;
  listen: StartConversationListening;
  createPlayer: () => VoicePlayback;
  context: () => VoiceTurnContext;
  queue: (event: VoiceQueueEvent) => Promise<boolean>;
  speech: Pick<UpstreamSpeech, 'readOffer' | 'followPort' | 'applyFirstRun' | 'readLocalModelInstalled'>;
  savedChoices: () => SavedSpeechChoices;
  firstRunMark: FirstRunMark;
  startSpeechState: () => () => void;
  watchAccount: (onChange: () => void) => () => void;
  account: () => string | null;
  window: VoiceWindow;
}

export interface VoiceController {
  session: VoiceSession;
  readiness(): VoiceReadiness | null;
  toggle(): void;
  end(): void;
  refreshReadiness(): Promise<void>;
  attach(): () => void;
}

async function setUpSpeech(deps: VoiceControllerDeps): Promise<void> {
  const offer: SpeechOffer | null = await deps.speech.readOffer();
  if (!offer?.offered) return;
  deps.speech.followPort(offer.baseUrl);
  const localModelInstalled = await deps.speech.readLocalModelInstalled();
  if (localModelInstalled === null) return;
  await deps.speech.applyFirstRun(
    offer.baseUrl,
    { ...deps.savedChoices(), localModelInstalled, carryDictation: offer.carryDictation },
    deps.firstRunMark,
  );
}

export function createVoiceController(deps: VoiceControllerDeps): VoiceController {
  let readiness: VoiceReadiness | null = null;
  let readinessRequest = 0;

  const session = new VoiceSession({
    listen: deps.listen,
    startConversation: () => deps.api.start(),
    endConversation: (conversationId) => {
      void deps.api.end(conversationId);
    },
    transcribe: async (wav, conversationId, signal) => {
      const transcript = await deps.api.transcribe(wav, conversationId, signal);
      speechQuotaStore.clear('stt');
      return transcript;
    },
    turn: deps.api.turn,
    synthesize: async (text, signal) => {
      const audio = await deps.api.synthesize(text, signal);
      speechQuotaStore.clear('tts');
      return audio;
    },
    createPlayer: deps.createPlayer,
    context: deps.context,
    onQueue: deps.queue,
    onEnd: () => {
      talkStore.getState().button?.focus();
    },
    onQuota: (kind, resetsAt) => {
      speechQuotaStore.block(kind, resetsAt);
    },
  });

  const end = () => session.end();

  const narrate = (text: string, tag?: string) => session.narrate(text, tag);

  const toggle = () => {
    if (session.getSnapshot().phase !== 'idle') {
      end();
      return;
    }
    if (!isTalkReady(readiness) || speechBlockedUntil('stt')) return;
    void session.start({ silenceMs: readiness.voiceSilenceMs });
  };

  const publish = () => {
    talkStore.setState({ readiness, phase: session.getSnapshot().phase, toggle, narrate });
  };

  const refreshReadiness = async () => {
    const request = ++readinessRequest;
    const next = await deps.api.readiness();
    if (request !== readinessRequest) return;
    readiness = next;
    publish();
  };

  const attach = () => {
    speechQuotaStore.setOwner(deps.account());
    publish();
    let unbindEscape: (() => void) | null = null;
    const stopWatchingSession = session.subscribe(() => {
      const open = session.getSnapshot().phase !== 'idle';
      if (open && !unbindEscape) unbindEscape = bindEscapeToEnd(deps.window, end);
      if (!open && unbindEscape) {
        unbindEscape();
        unbindEscape = null;
      }
      publish();
    });
    const refresh = () => {
      void refreshReadiness();
    };
    refresh();
    const timer = deps.window.setInterval(refresh, READINESS_REFRESH_MS);
    deps.window.addEventListener('focus', refresh);
    deps.window.addEventListener('pagehide', end);
    const stopSpeechState = deps.startSpeechState();
    const stopWatchingAccount = deps.watchAccount(() => {
      end();
      speechQuotaStore.setOwner(deps.account());
      refresh();
    });
    void setUpSpeech(deps);
    return () => {
      stopWatchingAccount();
      stopSpeechState();
      deps.window.removeEventListener('pagehide', end);
      deps.window.removeEventListener('focus', refresh);
      deps.window.clearInterval(timer);
      end();
      stopWatchingSession();
      unbindEscape?.();
      unbindEscape = null;
      talkStore.setState({ readiness: null, phase: 'idle', toggle: () => {}, narrate: () => {} });
    };
  };

  return { session, readiness: () => readiness, toggle, end, refreshReadiness, attach };
}
