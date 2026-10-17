import { describe, expect, test } from 'bun:test';

import type { AssistantMessage, Message, Part } from '../../../ui/src/lib/opencode/model';
import { resendAfterQuota, sendQuotaRetryPrompt, type QuotaRetryDeps, type QuotaRetryPrompt, type QuotaRetryTurn } from './resend';

const SESSION = 'ses_1';

const refusal = { type: 'provider.quota', message: 'Weekly model quota used up', status: 402, response: { body: '{"error":{"code":"llm_quota_exhausted"}}' } };

const assistant: AssistantMessage = {
  id: 'msg_a2',
  sessionID: SESSION,
  role: 'assistant',
  time: { created: 6 },
  agent: 'plan',
  providerID: 'mittr',
  modelID: 'pm_2',
  variant: 'high',
  finish: 'error',
  error: refusal,
};

const messages: Message[] = [
  { id: 'msg_u1', sessionID: SESSION, role: 'user', time: { created: 1 } },
  { id: 'msg_a1', sessionID: SESSION, role: 'assistant', time: { created: 2 }, agent: 'build', providerID: 'mittr', modelID: 'pm_1', finish: 'stop' },
  { id: 'msg_m', sessionID: SESSION, role: 'model-switched', time: { created: 3 }, model: { providerID: 'mittr', id: 'pm_2' } },
  { id: 'msg_s1', sessionID: SESSION, role: 'synthetic', time: { created: 4 }, text: 'Selected lines from cat.ts', description: 'Selection' },
  { id: 'msg_s2', sessionID: SESSION, role: 'synthetic', time: { created: 4 }, text: '   ' },
  { id: 'msg_u2', sessionID: SESSION, role: 'user', time: { created: 5 } },
  assistant,
];

const parts = new Map<string, Part[]>([
  ['msg_u1', [{ id: 'msg_u1:text:0', sessionID: SESSION, messageID: 'msg_u1', type: 'text', text: 'first ask' }]],
  ['msg_u2', [
    { id: 'msg_u2:text:0', sessionID: SESSION, messageID: 'msg_u2', type: 'text', text: 'draw a cat' },
    { id: 'msg_u2:file:0', sessionID: SESSION, messageID: 'msg_u2', type: 'file', mime: 'image/png', filename: 'cat.png', url: 'data:image/png;base64,AAA' },
    { id: 'msg_u2:agent:0', sessionID: SESSION, messageID: 'msg_u2', type: 'agent', name: 'artist' },
  ]],
]);

const partsOf = (messageId: string): readonly Part[] => parts.get(messageId) ?? [];

const turn: QuotaRetryTurn = { directory: '/repo', messages, partsOf };

const depsWith = (send: QuotaRetryDeps['send'], readTurn: QuotaRetryDeps['readTurn'] = () => turn): QuotaRetryDeps => ({
  readTurn,
  send,
  pending: new Set<string>(),
});

describe('resendAfterQuota', () => {
  test('Try again resends the same text and attachments', async () => {
    const sent: QuotaRetryPrompt[] = [];
    const ok = await resendAfterQuota(assistant, depsWith(async (prompt) => {
      sent.push(prompt);
    }));
    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe('draw a cat');
    expect(sent[0].files[0].url).toBe('data:image/png;base64,AAA');
    expect(sent[0]).toEqual({
      sessionId: SESSION,
      directory: '/repo',
      text: 'draw a cat',
      files: [{ mime: 'image/png', filename: 'cat.png', url: 'data:image/png;base64,AAA' }],
      syntheticTexts: ['Selected lines from cat.ts'],
      providerID: 'mittr',
      modelID: 'pm_2',
      agent: 'plan',
      agentMentionName: 'artist',
      variant: 'high',
    });
  });

  test('a double click sends once', async () => {
    let release = () => {};
    let sends = 0;
    const deps = depsWith(() => {
      sends += 1;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const first = resendAfterQuota(assistant, deps);
    expect(deps.pending.has(assistant.id)).toBe(true);
    expect(await resendAfterQuota(assistant, deps)).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(sends).toBe(1);
    expect(deps.pending.has(assistant.id)).toBe(false);
  });

  test('can be pressed again after a failed send', async () => {
    const deps = depsWith(async () => {
      throw new Error('offline');
    });
    expect(await resendAfterQuota(assistant, deps)).toBe(false);
    expect(deps.pending.has(assistant.id)).toBe(false);
  });

  test('sends nothing when the asking turn is gone', async () => {
    let sends = 0;
    const send = async () => {
      sends += 1;
    };
    expect(await resendAfterQuota(assistant, depsWith(send, () => null))).toBe(false);
    expect(await resendAfterQuota(assistant, depsWith(send, () => ({ messages: [assistant], partsOf: () => [] })))).toBe(false);
    const empty = { ...turn, partsOf: () => [] };
    expect(await resendAfterQuota(assistant, depsWith(send, () => empty))).toBe(false);
    expect(sends).toBe(0);
  });

  test('a plain question goes back without context, mentions or variant', async () => {
    const sent: QuotaRetryPrompt[] = [];
    const plain: AssistantMessage = { ...assistant, id: 'msg_a1b', variant: undefined };
    const plainTurn: QuotaRetryTurn = {
      messages: [messages[0], plain],
      partsOf,
    };
    expect(await resendAfterQuota(plain, depsWith(async (prompt) => {
      sent.push(prompt);
    }, () => plainTurn))).toBe(true);
    expect(sent[0]).toEqual({
      sessionId: SESSION,
      text: 'first ask',
      files: [],
      syntheticTexts: [],
      providerID: 'mittr',
      modelID: 'pm_2',
      agent: 'plan',
    });
  });

  test('the context before the asking turn is found past switch, system and skill records', async () => {
    const sent: QuotaRetryPrompt[] = [];
    const withPlumbing: Message[] = [
      messages[0],
      messages[1],
      { id: 'msg_s0', sessionID: SESSION, role: 'synthetic', time: { created: 3 }, text: 'Pinned notes' },
      { id: 'msg_m', sessionID: SESSION, role: 'model-switched', time: { created: 3 }, model: { providerID: 'mittr', id: 'pm_2' } },
      { id: 'msg_s1', sessionID: SESSION, role: 'synthetic', time: { created: 4 }, text: 'Selected lines from cat.ts' },
      { id: 'msg_sys', sessionID: SESSION, role: 'system', time: { created: 4 }, text: 'Instructions changed' },
      { id: 'msg_skill', sessionID: SESSION, role: 'skill', time: { created: 4 }, skill: 'review', name: 'review', text: 'Skill body' },
      messages[5],
      assistant,
    ];
    await resendAfterQuota(assistant, depsWith(async (prompt) => {
      sent.push(prompt);
    }, () => ({ messages: withPlumbing, partsOf })));
    expect(sent[0].syntheticTexts).toEqual(['Pinned notes', 'Selected lines from cat.ts']);
  });
});

describe('sendQuotaRetryPrompt', () => {
  test('passes every field to the position the session store sendMessage reads it from', async () => {
    const calls: Parameters<Parameters<typeof sendQuotaRetryPrompt>[1]>[] = [];
    await sendQuotaRetryPrompt({
      sessionId: SESSION,
      directory: '/repo',
      text: 'draw a cat',
      files: [{ url: 'data:image/png;base64,AAA', mime: 'image/png', filename: 'cat.png' }],
      syntheticTexts: ['Selected lines from cat.ts'],
      providerID: 'mittr',
      modelID: 'pm_2',
      agent: 'plan',
      agentMentionName: 'artist',
      variant: 'high',
    }, async (...args) => {
      calls.push(args);
    });
    expect(calls).toHaveLength(1);
    const [content, providerID, modelID, agent, attachments, agentMentionName, additionalParts, variant, inputMode, options] = calls[0];
    expect([content, providerID, modelID, agent, agentMentionName, variant, inputMode]).toEqual(['draw a cat', 'mittr', 'pm_2', 'plan', 'artist', 'high', 'normal']);
    expect(attachments?.map(({ dataUrl, mimeType, filename, source }) => ({ dataUrl, mimeType, filename, source }))).toEqual([
      { dataUrl: 'data:image/png;base64,AAA', mimeType: 'image/png', filename: 'cat.png', source: 'server' },
    ]);
    expect(attachments?.[0].file.name).toBe('cat.png');
    expect(additionalParts).toEqual([{ text: 'Selected lines from cat.ts', synthetic: true }]);
    expect(options).toEqual({ sessionId: SESSION, directory: '/repo' });
  });
});
