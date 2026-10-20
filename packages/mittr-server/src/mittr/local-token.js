import crypto from 'node:crypto';

/**
 * The key the engine presents to the shim. It opens only the shim, only from
 * this machine, and carries no authority at Mittr. The server mints one per
 * run and keeps it in memory only, so a key that leaked out of an engine
 * config (a repository can point the provider's URL elsewhere) dies with the
 * run.
 */
export const mintLocalToken = () => `mc_local_${crypto.randomBytes(32).toString('hex')}`;
