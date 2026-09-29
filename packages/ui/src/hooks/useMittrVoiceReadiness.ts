import { useEffect, useState } from 'react';

import { runtimeFetch } from '@/lib/runtime-fetch';
import { parseMittrVoiceReadiness, type MittrVoiceReadiness } from '@/lib/voice/mittrVoice';

export const useMittrVoiceReadiness = (active: boolean): MittrVoiceReadiness | null => {
    const [readiness, setReadiness] = useState<MittrVoiceReadiness | null>(null);

    useEffect(() => {
        if (!active) {
            return;
        }
        let cancelled = false;
        runtimeFetch('/api/voice/readiness')
            .then(async (response) => (response.ok ? parseMittrVoiceReadiness(await response.json()) : null))
            .catch(() => null)
            .then((next) => {
                if (!cancelled) {
                    setReadiness(next);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [active]);

    return active ? readiness : null;
};
