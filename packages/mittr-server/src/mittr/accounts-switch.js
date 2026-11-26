import { statusOf } from './auth-routes.js';

const SWITCH_REASON = 'mittr account switched';
const RESTARTS_PER_TARGET = 2;

export function createAccountSwitcher({ store, opencode, applyCache, sync, engineDataHome = null, logger = console }) {
  let queue = Promise.resolve();
  let triedFor;
  let lastSwitchCompleted = true;

  const warnSyncFailed = (error) => logger.warn('[mittr] catalog sync after the account change failed:', error?.message ?? error);
  const syncInBackground = () => {
    try {
      Promise.resolve(sync()).catch(warnSyncFailed);
    } catch (error) {
      warnSyncFailed(error);
    }
  };

  const targetHome = () => store.engineHome({ carryLegacy: false });

  const launchedHome = () => opencode.launchedDataHome?.() ?? null;
  const tracksEngine = () => Boolean(engineDataHome) && opencode.launchedDataHome instanceof Function;

  let readies = 0;
  let stopped = false;
  let unmanaged = false;
  const engineReady = () => {
    readies += 1;
    stopped = false;
    unmanaged = launchedHome() === null;
  };

  const engineOnTarget = () => {
    if (!tracksEngine()) return true;
    const launched = launchedHome();
    if (launched === null) return unmanaged;
    return !stopped && launched === engineDataHome(targetHome());
  };

  const engineOnAnotherHome = () => {
    if (!tracksEngine()) return false;
    const launched = launchedHome();
    return launched !== null && launched !== engineDataHome(targetHome());
  };

  const enqueue = (task) => {
    const done = queue.then(task);
    queue = done.catch(() => {});
    return done;
  };

  const restartOntoTarget = async () => {
    triedFor = targetHome();
    for (let attempt = 0; attempt < RESTARTS_PER_TARGET && !engineOnTarget(); attempt += 1) {
      const readiesBefore = readies;
      try {
        await opencode.refresh(SWITCH_REASON);
        stopped = false;
      } catch (error) {
        if (readies === readiesBefore) stopped = true;
        logger.warn('[mittr] the engine did not restart on the account\'s history:', error?.message ?? error);
        return { engineRestarted: false, engineError: { code: typeof error?.code === 'string' ? error.code : null, message: String(error?.message ?? error) } };
      }
    }
    if (!engineOnTarget()) {
      logger.warn('[mittr] the engine is still on another account\'s history after restarting');
      return { engineRestarted: false };
    }
    triedFor = undefined;
    return {};
  };

  const activeUserId = () => store.list().find((account) => account.active)?.userId ?? null;

  const run = async (userId) => {
    let mutation;
    try {
      if (activeUserId() !== userId) {
        mutation = await opencode.beforeAccountMutation?.();
        store.activate(userId);
      }
      lastSwitchCompleted = false;
      const cacheApplied = (await applyCache()) !== false;
      const restart = await restartOntoTarget();
      lastSwitchCompleted = cacheApplied;
      syncInBackground();
      return { ...statusOf(store.read()), ...restart };
    } finally { if (mutation !== undefined) await opencode.accountMutationSettled?.(mutation); }
  };

  const switchTo = (userId, { reconcile = false } = {}) => enqueue(() => run(reconcile ? activeUserId() : userId));

  const afterSignIn = async () => {
    syncInBackground();
  };

  const correctEngineHome = () => enqueue(async () => {
    if (!engineOnAnotherHome()) return;
    if (triedFor === targetHome()) {
      logger.warn('[mittr] the engine came up on another account\'s history again; Mittr answers stay closed until the next switch');
      return;
    }
    await restartOntoTarget();
  });

  const settledOnTarget = () => lastSwitchCompleted && engineOnTarget();

  return { switchTo, afterSignIn, engineReady, engineOnTarget, engineOnAnotherHome, settledOnTarget, correctEngineHome };
}
