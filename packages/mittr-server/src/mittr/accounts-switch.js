import { statusOf } from './auth-routes.js';

const SWITCH_REASON = 'mittr account switched';

export function createAccountSwitcher({ store, opencode, applyCache, sync, logger = console }) {
  let engineHome = store.activeHome({ carryLegacy: false });
  let queue = Promise.resolve();

  const warnSyncFailed = (error) => logger.warn('[mittr] catalog sync after the account change failed:', error?.message ?? error);
  const syncInBackground = () => {
    try {
      Promise.resolve(sync()).catch(warnSyncFailed);
    } catch (error) {
      warnSyncFailed(error);
    }
  };

  const activeUserId = () => store.list().find((account) => account.active)?.userId ?? null;

  const run = async (userId) => {
    if (activeUserId() !== userId) store.activate(userId);
    await applyCache();
    const home = store.activeHome();
    if (home !== engineHome) {
      engineHome = home;
      try {
        await opencode.refresh(SWITCH_REASON);
      } catch (error) {
        logger.warn('[mittr] the engine did not restart on the account\'s history:', error?.message ?? error);
      }
    }
    syncInBackground();
    return statusOf(store.read());
  };

  const switchTo = (userId) => {
    const switched = queue.then(() => run(userId));
    queue = switched.catch(() => {});
    return switched;
  };

  const afterSignIn = async (previousUserId, nextUserId) => {
    if (previousUserId !== nextUserId) {
      await switchTo(nextUserId);
      return;
    }
    syncInBackground();
  };

  return { switchTo, afterSignIn };
}
