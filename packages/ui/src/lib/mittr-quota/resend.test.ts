import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';

import { resendQuotaPrompt, sendQuotaRetryPrompt, useQuotaRetryPending } from './resend';
import type { QuotaRetryPrompt } from './retry';

const prompt: QuotaRetryPrompt = {
  sessionId: 'ses_1',
  directory: '/repo',
  text: 'fix the build',
  files: [{ url: 'data:image/png;base64,iVBOR', mime: 'image/png', filename: 'shot.png' }],
  syntheticTexts: ['Use the skill: review'],
  providerID: 'mittr',
  modelID: 'pm_2',
  agent: 'plan',
  agentMentionName: 'review',
  variant: 'high',
};

describe('sendQuotaRetryPrompt', () => {
  test('passes every field to the position sendMessage reads it from', async () => {
    const calls: unknown[][] = [];
    await sendQuotaRetryPrompt(prompt, async (...args: unknown[]) => {
      calls.push(args);
    });
    const [content, providerID, modelID, agent, attachments, agentMentionName, additionalParts, variant, inputMode, options] =
      calls[0] as [string, string, string, string, { dataUrl: string; mimeType: string; filename: string }[], string, unknown, string, string, unknown];
    expect([content, providerID, modelID, agent]).toEqual(['fix the build', 'mittr', 'pm_2', 'plan']);
    expect(agentMentionName).toBe('review');
    expect(attachments.map(({ dataUrl, mimeType, filename }) => ({ dataUrl, mimeType, filename }))).toEqual([
      { dataUrl: 'data:image/png;base64,iVBOR', mimeType: 'image/png', filename: 'shot.png' },
    ]);
    expect(additionalParts).toEqual([{ text: 'Use the skill: review', synthetic: true }]);
    expect([variant, inputMode]).toEqual(['high', 'normal']);
    expect(options).toEqual({ sessionId: 'ses_1', directory: '/repo' });
  });
});

const assistant = {
  id: 'msg_a',
  sessionID: 'ses_1',
  role: 'assistant',
  parentID: 'msg_u',
  providerID: 'mittr',
  modelID: 'pm_1',
  mode: 'build',
  time: { created: 2 },
} as unknown as Message;

const typed = { id: 'p1', sessionID: 'ses_1', messageID: 'msg_u', type: 'text', text: 'again' } as unknown as Part;

describe('resendQuotaPrompt', () => {
  test('sends once however often it is pressed while the send is pending', async () => {
    let release!: () => void;
    let sends = 0;
    const deps = {
      readTurn: () => ({ user: undefined, userParts: [typed] }),
      send: () => {
        sends += 1;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    };
    const first = resendQuotaPrompt(assistant, deps);
    expect(useQuotaRetryPending.getState().pending.msg_a).toBe(true);
    expect(await resendQuotaPrompt(assistant, deps)).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(sends).toBe(1);
    expect(useQuotaRetryPending.getState().pending.msg_a).toBe(undefined);
  });

  test('can be pressed again after a failed send', async () => {
    const deps = {
      readTurn: () => ({ user: undefined, userParts: [typed] }),
      send: async () => {
        throw new Error('offline');
      },
    };
    expect(await resendQuotaPrompt(assistant, deps)).toBe(false);
    expect(useQuotaRetryPending.getState().pending.msg_a).toBe(undefined);
  });
});
