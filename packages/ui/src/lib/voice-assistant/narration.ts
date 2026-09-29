import type { SpokenLanguage } from './turn';

export type NarrationEvent = 'done' | 'permission' | 'error';

export type SpokenKey = NarrationEvent | 'unavailable' | 'timeout' | 'notConfigured' | 'notSignedIn';

const SPOKEN: Record<SpokenLanguage, Record<SpokenKey, string>> = {
  en: {
    done: 'The work is done. Want a summary?',
    permission: 'A permission request is waiting on screen.',
    error: 'The work stopped with a problem; details are on screen.',
    unavailable: "Sorry, I can't answer right now.",
    timeout: 'Sorry, that took too long. Please try again.',
    notConfigured: 'The voice assistant is not set up on the Mittr platform yet.',
    notSignedIn: 'Sign in to Mittr to talk to the assistant.',
  },
  th: {
    done: 'งานเสร็จแล้ว อยากให้สรุปให้ฟังไหม',
    permission: 'มีคำขออนุญาตรออยู่บนหน้าจอ',
    error: 'งานหยุดเพราะมีปัญหา รายละเอียดอยู่บนหน้าจอ',
    unavailable: 'ขอโทษ ตอนนี้ยังตอบไม่ได้',
    timeout: 'ขอโทษ ใช้เวลานานเกินไป ลองใหม่อีกครั้งนะ',
    notConfigured: 'ผู้ช่วยเสียงยังไม่ได้ตั้งค่าบนแพลตฟอร์ม Mittr',
    notSignedIn: 'ลงชื่อเข้าใช้ Mittr ก่อนเพื่อคุยกับผู้ช่วย',
  },
};

const THAI = /\p{Script=Thai}/u;

let lastLanguage: SpokenLanguage = 'en';

export function spokenLanguageOf(text: string): SpokenLanguage {
  return THAI.test(text) ? 'th' : 'en';
}

export function noteUtterance(text: string): SpokenLanguage {
  lastLanguage = spokenLanguageOf(text);
  return lastLanguage;
}

export function spokenLanguage(): SpokenLanguage {
  return lastLanguage;
}

export function resetSpokenLanguage(): void {
  lastLanguage = 'en';
}

export function spokenText(key: SpokenKey, language: SpokenLanguage = lastLanguage): string {
  return SPOKEN[language][key];
}

export interface SessionObservation {
  sessionId: string | null;
  busy: boolean;
  permissionIds: readonly string[];
  errorAt: number | null;
}

export interface NarrationWatch {
  observe(view: SessionObservation): NarrationEvent[];
}

export function createNarrationWatch(): NarrationWatch {
  let current: string | null = null;
  let busy = false;
  let errorAt: number | null = null;
  let permissions = new Set<string>();

  const baseline = (view: SessionObservation) => {
    current = view.sessionId;
    busy = view.busy;
    errorAt = view.errorAt;
    permissions = new Set(view.permissionIds);
  };

  return {
    observe(view) {
      if (!view.sessionId) {
        baseline(view);
        return [];
      }
      if (view.sessionId !== current) {
        baseline(view);
        return [];
      }
      const out: NarrationEvent[] = [];
      if (view.permissionIds.some((id) => !permissions.has(id))) out.push('permission');
      permissions = new Set(view.permissionIds);
      const failed = view.errorAt !== null && (errorAt === null || view.errorAt > errorAt);
      if (failed) out.push('error');
      else if (busy && !view.busy) out.push('done');
      busy = view.busy;
      errorAt = view.errorAt;
      return out;
    },
  };
}
