import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';

import { resendAfterQuota, type QuotaRetryPrompt } from './retry';

const assistant = {
  id: 'msg_a',
  sessionID: 'ses_1',
  role: 'assistant',
  parentID: 'msg_u',
  providerID: 'mittr',
  modelID: 'pm_1',
  mode: 'build',
  time: { created: 2 },
  error: { name: 'APIError', data: { message: 'quota', isRetryable: false } },
} as unknown as Message;

const user = {
  id: 'msg_u',
  sessionID: 'ses_1',
  role: 'user',
  agent: 'plan',
  model: { providerID: 'mittr', modelID: 'pm_2', variant: 'high' },
  time: { created: 1 },
} as unknown as Message;

const textPart = (text: string, extra: Record<string, unknown> = {}) =>
  ({ id: `p_${text}`, sessionID: 'ses_1', messageID: 'msg_u', type: 'text', text, ...extra }) as unknown as Part;

describe('resendAfterQuota', () => {
  test('sends the same typed prompt again with the model and agent it was sent with', async () => {
    const sent: QuotaRetryPrompt[] = [];
    const ok = await resendAfterQuota(assistant, {
      readTurn: (sessionId, messageId) => {
        expect([sessionId, messageId]).toEqual(['ses_1', 'msg_u']);
        return {
          directory: '/repo',
          user,
          userParts: [textPart('fix the build'), textPart('<file contents>', { synthetic: true })],
        };
      },
      send: async (prompt) => {
        sent.push(prompt);
      },
    });
    expect(ok).toBe(true);
    expect(sent).toEqual([
      { sessionId: 'ses_1', directory: '/repo', text: 'fix the build', providerID: 'mittr', modelID: 'pm_2', agent: 'plan', variant: 'high' },
    ]);
  });

  test('falls back to the model that answered when the prompt carries none', async () => {
    const sent: QuotaRetryPrompt[] = [];
    await resendAfterQuota(assistant, {
      readTurn: () => ({ user: undefined, userParts: [textPart('again')] }),
      send: async (prompt) => {
        sent.push(prompt);
      },
    });
    expect(sent[0]).toEqual({ sessionId: 'ses_1', text: 'again', providerID: 'mittr', modelID: 'pm_1', agent: 'build' });
  });

  test('sends nothing when the prompt text is gone', async () => {
    let calls = 0;
    const ok = await resendAfterQuota(assistant, {
      readTurn: () => ({ user, userParts: [] }),
      send: async () => {
        calls += 1;
      },
    });
    expect(ok).toBe(false);
    expect(calls).toBe(0);
  });
});
