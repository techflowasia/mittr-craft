export function createRecoveryTransitions({ suspend, resume, identity }: { suspend: () => Promise<void>; resume: () => Promise<void>; identity: () => string }) {
  const pending = new Map<symbol, string>();
  let failed = false;
  let revision = 0;
  const ready = async (): Promise<void> => {
    if (failed || pending.size) return;
    const expected = revision;
    const owner = identity();
    await Promise.resolve();
    if (!failed && !pending.size && expected === revision && owner === identity()) await resume();
  };
  return {
    ready,
    async begin(): Promise<symbol> {
      const token = Symbol('account-transition');
      pending.set(token, identity()); revision++;
      try { await suspend(); return token; }
      catch (error) { failed = true; throw error; }
    },
    async end(token: symbol): Promise<void> {
      if (!pending.delete(token)) return;
      revision++;
      await ready();
    },
  };
}
