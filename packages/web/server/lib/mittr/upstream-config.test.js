import { describe, expect, it } from 'vitest';
import { resolveUpstream } from './upstream-config.js';

describe('resolveUpstream', () => {
  it('returns the configured upstream', () => {
    expect(resolveUpstream({
      MITTRCRAFT_UPSTREAM_URL: 'https://llm-dev.mittr.asia/v1',
      MITTRCRAFT_UPSTREAM_TOKEN: 'sk-test',
    })).toEqual({ baseUrl: 'https://llm-dev.mittr.asia/v1', token: 'sk-test' });
  });

  it('strips a trailing slash so path joining stays predictable', () => {
    expect(resolveUpstream({
      MITTRCRAFT_UPSTREAM_URL: 'https://llm-dev.mittr.asia/v1/',
      MITTRCRAFT_UPSTREAM_TOKEN: 'sk-test',
    }).baseUrl).toBe('https://llm-dev.mittr.asia/v1');
  });

  it('fails closed when the url is missing', () => {
    expect(() => resolveUpstream({ MITTRCRAFT_UPSTREAM_TOKEN: 'sk-test' }))
      .toThrow(/MITTRCRAFT_UPSTREAM_URL/);
  });

  it('fails closed when the token is missing', () => {
    expect(() => resolveUpstream({ MITTRCRAFT_UPSTREAM_URL: 'https://x/v1' }))
      .toThrow(/MITTRCRAFT_UPSTREAM_TOKEN/);
  });

  it('rejects a non-https upstream that is not loopback', () => {
    expect(() => resolveUpstream({
      MITTRCRAFT_UPSTREAM_URL: 'http://llm-dev.mittr.asia/v1',
      MITTRCRAFT_UPSTREAM_TOKEN: 'sk-test',
    })).toThrow(/https/);
  });
});
