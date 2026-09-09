import { describe, expect, it } from 'vitest';
import { resolveBrokerBaseUrl } from './broker-target.js';

describe('resolveBrokerBaseUrl', () => {
  it('defaults to the production API host', () => {
    expect(resolveBrokerBaseUrl()).toBe('https://api.mittr.asia');
  });

  it('takes the environment when nothing was baked into the build', () => {
    expect(resolveBrokerBaseUrl({ env: { MITTRCRAFT_BROKER_URL: 'https://api-dev.mittr.asia' } }))
      .toBe('https://api-dev.mittr.asia');
  });

  it('lets a packaged build override the environment, so an installed app cannot be steered', () => {
    expect(resolveBrokerBaseUrl({
      packaged: 'https://api-dev.mittr.asia',
      env: { MITTRCRAFT_BROKER_URL: 'https://somewhere-else.example' },
    })).toBe('https://api-dev.mittr.asia');
  });

  it('ignores an empty baked value rather than treating it as a choice', () => {
    expect(resolveBrokerBaseUrl({ packaged: '  ', env: { MITTRCRAFT_BROKER_URL: 'https://api-dev.mittr.asia' } }))
      .toBe('https://api-dev.mittr.asia');
  });

  it('allows loopback so the path can be exercised against a local instance', () => {
    expect(resolveBrokerBaseUrl({ packaged: 'http://127.0.0.1:3000' })).toBe('http://127.0.0.1:3000');
  });

  it('refuses plain http anywhere else, because this carries a session token', () => {
    expect(() => resolveBrokerBaseUrl({ packaged: 'http://api-dev.mittr.asia' })).toThrow(/https/);
  });

  it('refuses a url carrying a path, which every endpoint would silently drop', () => {
    // new URL('/desktop/catalog', 'https://host/api') resolves to https://host/desktop/catalog,
    // so a prefixed host would look configured and reach the wrong place.
    expect(() => resolveBrokerBaseUrl({ packaged: 'https://api.mittr.asia/api' })).toThrow(/origin/);
  });

  it('refuses nonsense instead of quietly falling back to production', () => {
    expect(() => resolveBrokerBaseUrl({ packaged: 'not a url' })).toThrow(/valid URL/);
  });

  it('reduces a host with a trailing slash to its origin', () => {
    expect(resolveBrokerBaseUrl({ packaged: 'https://api-dev.mittr.asia/' })).toBe('https://api-dev.mittr.asia');
  });
});
