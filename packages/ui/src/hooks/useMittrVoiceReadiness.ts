import { useEffect, useState } from 'react';

import { SIGN_IN_COMPLETED_EVENT } from '@/components/mittr/mittrSignInGateState';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { parseMittrVoiceReadiness, type MittrVoiceReadiness } from '@/lib/voice/mittrVoice';

const READY_CACHE_TTL_MS = 30000;

let readyCache: { readiness: MittrVoiceReadiness; checkedAt: number } | null = null;
let inFlight: Promise<MittrVoiceReadiness | null> | null = null;

export const readMittrVoiceReadiness = async (): Promise<MittrVoiceReadiness | null> => {
    if (readyCache && Date.now() - readyCache.checkedAt < READY_CACHE_TTL_MS) {
        return readyCache.readiness;
    }
    if (inFlight) {
        return inFlight;
    }
    inFlight = (async () => {
        try {
            const response = await runtimeFetch('/api/voice/readiness');
            const readiness = response.ok ? parseMittrVoiceReadiness(await response.json().catch(() => null)) : null;
            readyCache = readiness?.speak ? { readiness, checkedAt: Date.now() } : null;
            return readiness;
        } catch {
            readyCache = null;
            return null;
        } finally {
            inFlight = null;
        }
    })();
    return inFlight;
};

export const forgetMittrVoiceReadiness = (): void => {
    readyCache = null;
};

export const useMittrVoiceReadiness = (active: boolean): MittrVoiceReadiness | null => {
    const [readiness, setReadiness] = useState<MittrVoiceReadiness | null>(null);

    useEffect(() => {
        if (!active) {
            return;
        }
        let cancelled = false;
        const refresh = () => {
            void readMittrVoiceReadiness().then((next) => {
                if (!cancelled) {
                    setReadiness(next);
                }
            });
        };
        const refreshAfterSignIn = () => {
            forgetMittrVoiceReadiness();
            refresh();
        };
        refresh();
        window.addEventListener(SIGN_IN_COMPLETED_EVENT, refreshAfterSignIn);
        return () => {
            cancelled = true;
            window.removeEventListener(SIGN_IN_COMPLETED_EVENT, refreshAfterSignIn);
        };
    }, [active]);

    return active ? readiness : null;
};
