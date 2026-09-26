import { describe, expect, it } from 'vitest';
import { authRedirectUri, deepLinkScheme } from './deep-link-scheme.js';

describe('deep link scheme', () => {
  it('is the production scheme when nothing declares another', () => {
    expect(deepLinkScheme({})).toBe('mittrcraft');
    expect(authRedirectUri({})).toBe('mittrcraft://auth/callback');
  });

  it('follows the scheme the desktop flavor declares', () => {
    expect(authRedirectUri({ MITTRCRAFT_DEEP_LINK_SCHEME: 'mittrcraft-dev' })).toBe('mittrcraft-dev://auth/callback');
  });

  it('refuses a value that is not a URL scheme', () => {
    expect(() => deepLinkScheme({ MITTRCRAFT_DEEP_LINK_SCHEME: 'https://evil.test' })).toThrow(/not a valid URL scheme/);
  });
});
