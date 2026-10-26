import { keyOf } from '../account-store.js';
import { ACCOUNT_CHANGED } from '../platform.js';
import { MittrToolError } from './registry.js';

export const sessionKeyOf = (session) => {
  const userId = session?.subject?.userId;
  return userId === String(userId) && userId ? keyOf(userId) : null;
};

export const pinAccount = ({ activeAccountKey, engineOnActiveHome }) => {
  if (!(engineOnActiveHome instanceof Function)) throw new Error('pinAccount needs engineOnActiveHome');
  const pinned = activeAccountKey();
  return (sessionKey = pinned) => {
    if (activeAccountKey() !== pinned || sessionKey !== pinned || engineOnActiveHome() !== true) {
      throw new MittrToolError(ACCOUNT_CHANGED, 409);
    }
  };
};
