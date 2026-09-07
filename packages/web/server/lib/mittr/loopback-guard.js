const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

// A shim reachable off-host hands every machine on the network a free,
// authenticated route into Mittr, and the audit trail credits whoever owns the
// machine it ran on. Refusing to start is the only safe response.
export function assertLoopbackHost(host) {
  const normalized = String(host ?? '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!LOOPBACK_HOSTS.has(normalized)) {
    throw new Error(`The Mittr shim may only bind a loopback address, refusing: ${host}`);
  }
}
