import { describe, expect, test } from 'bun:test';
import { parseMittrAccounts } from './mittrAccountsApi';

describe('parseMittrAccounts', () => {
  test('keeps well-formed accounts and the one in use', () => {
    expect(parseMittrAccounts({
      accounts: [
        { userId: 'u1', displayName: 'Chaiwat', active: false },
        { userId: 'u2', displayName: 'Chaiwat (test)', active: true },
      ],
    })).toEqual([
      { userId: 'u1', displayName: 'Chaiwat', active: false },
      { userId: 'u2', displayName: 'Chaiwat (test)', active: true },
    ]);
  });

  test('drops entries without a user id and answers an empty list for anything else', () => {
    expect(parseMittrAccounts({ accounts: [{ displayName: 'x' }, { userId: 'u1' }] })).toEqual([
      { userId: 'u1', displayName: '', active: false },
    ]);
    expect(parseMittrAccounts(null)).toEqual([]);
    expect(parseMittrAccounts({ accounts: 'nope' })).toEqual([]);
  });
});
