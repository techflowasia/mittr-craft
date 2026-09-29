import React from 'react';

import { SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { MittrVoiceReason } from '@/lib/voice/mittrVoice';

const REASON_KEYS = {
    not_signed_in: 'settings.voice.mittr.reason.not_signed_in',
    not_configured: 'settings.voice.mittr.reason.not_configured',
    unreachable: 'settings.voice.mittr.reason.unreachable',
} as const;

export const MittrVoiceProviderNote: React.FC<{ reason: MittrVoiceReason | null }> = ({ reason }) => {
    const { t } = useI18n();
    if (!reason) {
        return null;
    }
    return (
        <p role="status" className={cn(SETTINGS_HELPER_CLASS, 'text-[var(--status-warning)]')}>
            {t(REASON_KEYS[reason])}
        </p>
    );
};
