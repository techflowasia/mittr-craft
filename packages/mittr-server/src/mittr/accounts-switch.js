import { statusOf } from './auth-routes.js';

const SWITCH_REASON = 'mittr account switched';
const RESTARTS_PER_TARGET = 2;

export function createAccountSwitcher({ store, opencode, applyCache, sync, engineDataHome = null, logger = console }) {
  let queue = Promise.resolve();
  let triedFor;

  const warnSyncFailed = (error) => logger.warn('[mittr] catalog sync after the account change failed:', error?.message ?? error);
  const syncInBackground = () => {
    try {
      Promise.resolve(sync()).catch(warnSyncFailed);
    } catch (error) {
      warnSyncFailed(error);
    }
  };

  const targetHome = () => store.engineHome({ carryLegacy: false });

  const engineOnTarget = () => {
    if (!engineDataHome) return true;
    const launched = opencode.launchedDataHome?.() ?? null;
    return launched === null || launched === engineDataHome(targetHome());
  };

  const enqueue = (task) => {
    const done = queue.then(task);
    queue = done.catch(() => {});
    return done;
  };

  const restartOntoTarget = async () => {
    triedFor = targetHome();
    for (let attempt = 0; attempt < RESTARTS_PER_TARGET && !engineOnTarget(); attempt += 1) {
      try {
        await opencode.refresh(SWITCH_REASON);
      } catch (error) {
        logger.warn('[mittr] the engine did not restart on the account\'s history:', error?.message ?? error);
        return false;
      }
    }
    if (!engineOnTarget()) {
      logger.warn('[mittr] the engine is still on another account\'s history after restarting');
      return false;
    }
    triedFor = undefined;
    return true;
  };

  const activeUserId = () => store.list().find((account) => account.active)?.userId ?? null;

  const run = async (userId) => {
    if (activeUserId() !== userId) store.activate(userId);
    await applyCache();
    const engineRestarted = await restartOntoTarget();
    syncInBackground();
    const status = statusOf(store.read());
    return engineRestarted ? status : { ...status, engineRestarted: false };
  };

  const switchTo = (userId) => enqueue(() => run(userId));

  const afterSignIn = () => {
    syncInBackground();
  };

  const correctEngineHome = () => enqueue(async () => {
    if (engineOnTarget()) return;
    if (triedFor === targetHome()) {
      logger.warn('[mittr] the engine came up on another account\'s history again; Mittr answers stay closed until the next switch');
      return;
    }
    await restartOntoTarget();
  });

  return { switchTo, afterSignIn, engineOnTarget, correctEngineHome };
}
