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

const filePart = (url: string, mime: string, filename: string) =>
  ({ id: `f_${filename}`, sessionID: 'ses_1', messageID: 'msg_u', type: 'file', url, mime, filename }) as unknown as Part;

const agentPart = (name: string) =>
  ({ id: `a_${name}`, sessionID: 'ses_1', messageID: 'msg_u', type: 'agent', name }) as unknown as Part;

const collect = async (userParts: Part[], turnUser: Message | null = user) => {
  const sent: QuotaRetryPrompt[] = [];
  const ok = await resendAfterQuota(assistant, {
    readTurn: () => ({ directory: '/repo', user: turnUser ?? undefined, userParts }),
    send: async (prompt) => {
      sent.push(prompt);
    },
  });
  return { ok, sent };
};

describe('resendAfterQuota', () => {
  test('reads the turn the failed answer belongs to', async () => {
    const asked: string[][] = [];
    await resendAfterQuota(assistant, {
      readTurn: (sessionId, messageId) => {
        asked.push([sessionId, messageId]);
        return { user, userParts: [textPart('fix the build')] };
      },
      send: async () => {},
    });
    expect(asked).toEqual([['ses_1', 'msg_u']]);
  });

  test('sends the same typed prompt again with the model and agent it was sent with', async () => {
    const { ok, sent } = await collect([textPart('fix the build')]);
    expect(ok).toBe(true);
    expect(sent).toEqual([
      {
        sessionId: 'ses_1',
        directory: '/repo',
        text: 'fix the build',
        files: [],
        syntheticTexts: [],
        providerID: 'mittr',
        modelID: 'pm_2',
        agent: 'plan',
        variant: 'high',
      },
    ]);
  });

  test('joins several typed text parts with a newline', async () => {
    const { sent } = await collect([textPart('first line'), textPart('second line')]);
    expect(sent[0].text).toBe('first line\nsecond line');
  });

  test('resends attachments and the contents the app itself added, leaving the engine to expand files again', async () => {
    const { sent } = await collect([
      textPart('summarise these'),
      textPart('Called the Read tool with the following input: {"filePath":"notes.txt"}', { synthetic: true }),
      textPart('hello from notes', { synthetic: true }),
      filePart('data:text/plain;base64,aGVsbG8=', 'text/plain', 'notes.txt'),
      filePart('data:image/png;base64,iVBOR', 'image/png', 'shot.png'),
      textPart('[slides.pptx] extracted slide text', { synthetic: true }),
      textPart('Use the skill: review', { synthetic: true }),
    ]);
    expect(sent[0].text).toBe('summarise these');
    expect(sent[0].files).toEqual([
      { url: 'data:text/plain;base64,aGVsbG8=', mime: 'text/plain', filename: 'notes.txt' },
      { url: 'data:image/png;base64,iVBOR', mime: 'image/png', filename: 'shot.png' },
    ]);
    expect(sent[0].syntheticTexts).toEqual(['[slides.pptx] extracted slide text', 'Use the skill: review']);
  });

  test('resends an agent mention without the instruction the engine added for it', async () => {
    const { sent } = await collect([
      textPart('@review check this'),
      agentPart('review'),
      textPart(' Use the above message and context to generate a prompt and call the task tool with subagent: review', { synthetic: true }),
    ]);
    expect(sent[0].agentMentionName).toBe('review');
    expect(sent[0].syntheticTexts).toEqual([]);
  });

  test('resends a prompt that was only an attachment', async () => {
    const { ok, sent } = await collect([filePart('data:image/png;base64,iVBOR', 'image/png', 'shot.png')]);
    expect(ok).toBe(true);
    expect(sent[0].text).toBe('');
    expect(sent[0].files).toHaveLength(1);
  });

  test('falls back to the model that answered when the prompt carries none', async () => {
    const { sent } = await collect([textPart('again')], null);
    expect([sent[0].providerID, sent[0].modelID, sent[0].agent]).toEqual(['mittr', 'pm_1', 'build']);
  });

  test('sends nothing when the prompt is gone', async () => {
    const { ok, sent } = await collect([]);
    expect(ok).toBe(false);
    expect(sent).toHaveLength(0);
  });
});
