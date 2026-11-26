import { describe, expect, test } from 'bun:test';
import { isResponseLengthLimit } from './error.js';

const structured = (body) => ({ type: 'provider.error', message: 'limited', response: { body } });

describe('isResponseLengthLimit', () => {
  test('accepts only the exact nested code in the structured response body', () => {
    expect(isResponseLengthLimit(structured(' { "error": { "code": "response_length_limit" } }\n'))).toBe(true);
  });

  for (const [name, error] of [
    ['missing error', undefined],
    ['null error', null],
    ['plain error string', 'response_length_limit'],
    ['prose', { message: 'response_length_limit' }],
    ['finish length', { finish: 'length' }],
    ['status alone', { status: 502 }],
    ['quota', structured('{"error":{"code":"llm_quota_exhausted"}}')],
    ['network', structured('{"error":{"code":"platform_unreachable"}}')],
    ['malformed JSON', structured('{"error":')],
    ['plain body', structured('response_length_limit')],
    ['JSON string', structured('"response_length_limit"')],
    ['root code', structured('{"code":"response_length_limit"}')],
    ['deeper code', structured('{"data":{"error":{"code":"response_length_limit"}}}')],
    ['prose in JSON', structured('{"error":{"message":"response_length_limit"}}')],
    ['wrong case', structured('{"error":{"code":"RESPONSE_LENGTH_LIMIT"}}')],
    ['padded code', structured('{"error":{"code":" response_length_limit "}}')],
    ['null body', structured(null)],
    ['object body', structured({ error: { code: 'response_length_limit' } })],
    ['wrong response nesting', { data: structured('{"error":{"code":"response_length_limit"}}') }],
    ['array body', structured('[{"error":{"code":"response_length_limit"}}]')],
    ['null JSON', structured('null')],
  ]) {
    test(`rejects ${name}`, () => {
      expect(isResponseLengthLimit(error)).toBe(false);
    });
  }
});
