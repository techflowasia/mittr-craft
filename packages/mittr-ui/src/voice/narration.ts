import type { Session, SessionOutcome } from '../../../ui/src/lib/opencode/model';
import type { SpokenLanguage } from './voiceApi';

export type NarrationEvent = 'done' | 'permission' | 'error' | 'stopped';

export type SpokenKey = NarrationEvent | 'unavailable' | 'timeout' | 'notConfigured' | 'notSignedIn';

const SPOKEN = {
  en: {
    done: 'The work is done. Want a summary?',
    permission: 'A permission request is waiting on screen.',
    error: 'The work stopped with a problem; details are on screen.',
    stopped: 'The work has stopped.',
    unavailable: "Sorry, I can't answer right now.",
    timeout: 'Sorry, that took too long. Please try again.',
    notConfigured: 'The voice assistant is not set up on the Mittr platform yet.',
    notSignedIn: 'Sign in to Mittr to talk to the assistant.',
  },
  th: {
    done: 'งานเสร็จแล้ว อยากให้สรุปให้ฟังไหม',
    permission: 'มีคำขออนุญาตรออยู่บนหน้าจอ',
    error: 'งานหยุดเพราะมีปัญหา รายละเอียดอยู่บนหน้าจอ',
    stopped: 'งานหยุดแล้ว',
    unavailable: 'ขอโทษ ตอนนี้ยังตอบไม่ได้',
    timeout: 'ขอโทษ ใช้เวลานานเกินไป ลองใหม่อีกครั้งนะ',
    notConfigured: 'ผู้ช่วยเสียงยังไม่ได้ตั้งค่าบนแพลตฟอร์ม Mittr',
    notSignedIn: 'ลงชื่อเข้าใช้ Mittr ก่อนเพื่อคุยกับผู้ช่วย',
  },
} satisfies Record<SpokenLanguage, Record<SpokenKey, string>>;

const THAI = /\p{Script=Thai}/u;

let lastLanguage: SpokenLanguage = 'en';

export function spokenLanguageOf(text: string): SpokenLanguage {
  return THAI.test(text) ? 'th' : 'en';
}

export function noteUtterance(text: string): SpokenLanguage {
  lastLanguage = spokenLanguageOf(text);
  return lastLanguage;
}

export function spokenText(key: SpokenKey, language: SpokenLanguage = lastLanguage): string {
  return SPOKEN[language][key];
}

export interface SessionError {
  at: number;
  aborted: boolean;
}

export interface SessionEnding {
  at: number;
  outcome: SessionOutcome | null;
}

export interface SessionObservation {
  sessionId: string | null;
  busy: boolean;
  permissionIds: readonly string[];
  error: SessionError | null;
  ended: SessionEnding | null;
}

export interface NarrationWatch {
  observe(view: SessionObservation): NarrationEvent[];
}

export function endingOf(session: Pick<Session, 'outcome' | 'time'> | null | undefined): SessionEnding | null {
  const at = session?.time.idle;
  return at === undefined ? null : { at, outcome: session?.outcome ?? null };
}

export function createNarrationWatch(): NarrationWatch {
  let current: string | null = null;
  let busy = false;
  let errorAt: number | null = null;
  let endedAt: number | null = null;
  let erroredThisRun = false;
  let errorSpokenFromOutcome = false;
  let permissions = new Set<string>();

  const baseline = (view: SessionObservation) => {
    current = view.sessionId;
    busy = view.busy;
    errorAt = view.error?.at ?? null;
    endedAt = view.ended?.at ?? null;
    erroredThisRun = false;
    errorSpokenFromOutcome = false;
    permissions = new Set(view.permissionIds);
  };

  const endOf = (ended: SessionEnding | null): NarrationEvent => {
    const fresh = ended && (endedAt === null || ended.at > endedAt) ? ended.outcome : null;
    if (fresh === 'interrupted') return 'stopped';
    if (fresh === 'failed') return 'error';
    return 'done';
  };

  return {
    observe(view) {
      if (!view.sessionId || view.sessionId !== current) {
        baseline(view);
        return [];
      }
      const out: NarrationEvent[] = [];
      if (view.permissionIds.some((id) => !permissions.has(id))) out.push('permission');
      permissions = new Set(view.permissionIds);
      if (!busy && view.busy) {
        erroredThisRun = false;
        errorSpokenFromOutcome = false;
      }
      const error = view.error;
      if (error && (errorAt === null || error.at > errorAt)) {
        if (!errorSpokenFromOutcome) out.push(error.aborted ? 'stopped' : 'error');
        errorSpokenFromOutcome = false;
        erroredThisRun = true;
        errorAt = error.at;
      }
      if (busy && !view.busy) {
        const ending = endOf(view.ended);
        if (!erroredThisRun) {
          out.push(ending);
          if (ending === 'error') {
            erroredThisRun = true;
            errorSpokenFromOutcome = true;
          }
        }
        endedAt = view.ended?.at ?? endedAt;
      }
      busy = view.busy;
      return out;
    },
  };
}
