import type { JsonValue } from '@openchamber/sdk';
import { describe, expect, test } from 'bun:test';

import { errorTextOf, readJsonReply } from './errorReply';

describe('errorReply', () => {
  test('errorTextOf answers a non-blank error, or the fallback', () => {
    expect(errorTextOf({ error: 'Jira refused' }, 'fallback')).toBe('Jira refused');
    const bodies: (JsonValue | undefined)[] = [undefined, null, 'text', {}, { error: '  ' }, { error: 7 }, { message: 'x' }];
    for (const body of bodies) {
      expect(errorTextOf(body, 'fallback')).toBe('fallback');
    }
  });

  test('readJsonReply answers the body, or undefined when it is not JSON', async () => {
    expect(await readJsonReply({ json: async () => ({ ok: true }) })).toEqual({ ok: true });
    expect(await readJsonReply({ json: async () => { throw new SyntaxError('bad'); } })).toBeUndefined();
  });
});
