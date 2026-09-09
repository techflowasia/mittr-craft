import { describe, expect, it } from 'vitest';
import { resolveUpstream } from './upstream-config.js';

describe('resolveUpstream', () => {
  it('returns the configured upstream', () => {
    expect(resolveUpstream({ MITTRCRAFT_UPSTREAM_URL: 'https://llm-dev.mittr.asia/v1' }))
      .toEqual({ baseUrl: 'https://llm-dev.mittr.asia/v1' });
  });

  it('carries no credential: the signed-in session is what authorises a call', () => {
    const upstream = resolveUpstream({
      MITTRCRAFT_UPSTREAM_URL: 'https://llm-dev.mittr.asia/v1',
      MITTRCRAFT_UPSTREAM_TOKEN: 'sk-should-be-ignored',
    });
    expect(upstream).not.toHaveProperty('token');
    expect(JSON.stringify(upstream)).not.toContain('sk-should-be-ignored');
  });

  it('strips a trailing slash so path joining stays predictable', () => {
    expect(resolveUpstream({ MITTRCRAFT_UPSTREAM_URL: 'https://llm-dev.mittr.asia/v1/' }).baseUrl).toBe('https://llm-dev.mittr.asia/v1');
  });

  it('fails closed when the url is missing', () => {
    expect(() => resolveUpstream({})).toThrow(/MITTRCRAFT_UPSTREAM_URL/);
  });

  it('rejects a non-https upstream that is not loopback', () => {
    expect(() => resolveUpstream({ MITTRCRAFT_UPSTREAM_URL: 'http://llm-dev.mittr.asia/v1' }))
      .toThrow(/https/);
  });
});

describe('resolveUpstream defaults', () => {
  it('derives the upstream from the broker, so the two cannot disagree', () => {
    expect(resolveUpstream({}, { defaultBaseUrl: 'https://api.mittr.asia/v1' }))
      .toEqual({ baseUrl: 'https://api.mittr.asia/v1' });
  });

  it('lets a development run point at a local stand-in', () => {
    expect(resolveUpstream(
      { MITTRCRAFT_UPSTREAM_URL: 'http://127.0.0.1:4599/v1' },
      { defaultBaseUrl: 'https://api.mittr.asia/v1' },
    )).toEqual({ baseUrl: 'http://127.0.0.1:4599/v1' });
  });

  it('ignores the environment in a packaged build, which must not be repointable', () => {
    expect(resolveUpstream(
      { MITTRCRAFT_UPSTREAM_URL: 'https://somewhere-else.example/v1' },
      { defaultBaseUrl: 'https://api.mittr.asia/v1', allowOverride: false },
    )).toEqual({ baseUrl: 'https://api.mittr.asia/v1' });
  });
});
