import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { SimpleMarkdownRenderer } from '../MarkdownRenderer';
import type { ToolPopupContent } from './types';

export interface AssistantErrorNoticeProps {
    message: string;
    variant: 'error' | 'info';
    action?: React.ReactNode;
    onShowPopup: (content: ToolPopupContent) => void;
}

export function AssistantErrorNotice({ message, variant, action, onShowPopup }: AssistantErrorNoticeProps) {
    return (
        <div className={cn(
            'group/assistant-text relative mt-3 p-3 rounded-lg border break-words max-w-full',
            variant === 'info'
                ? 'bg-[var(--status-info-background)] border-[var(--status-info-border)]'
                : 'bg-[var(--status-error-background)] border-[var(--status-error-border)]',
        )}>
            <div className="flex items-center gap-2">
                <Icon name={variant === 'info' ? 'information' : 'error-warning'} className={cn(
                    'h-4 w-4 shrink-0',
                    variant === 'info' ? 'text-[var(--status-info)]' : 'text-[var(--status-error)]',
                )} />
                <div className="min-w-0 flex-1 break-words">
                    <SimpleMarkdownRenderer
                        content={message}
                        onShowPopup={onShowPopup}
                        className="[&_.markdown-content>*:first-child]:mt-0 [&_.markdown-content>*:last-child]:mb-0"
                        enableFileReferences={false}
                    />
                </div>
                {action}
            </div>
        </div>
    );
}
