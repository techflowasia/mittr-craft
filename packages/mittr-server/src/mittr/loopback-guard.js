const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Headers a tunnel, reverse proxy or the relay adds when it hands a request
// from elsewhere to this server over loopback. The engine sends none of them.
const RELAY_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'via',
  'x-real-ip',
  'x-client-ip',
  'true-client-ip',
  'cf-connecting-ip',
  'tailscale-user-login',
  'x-openchamber-relay-connection',
];

/** True for the addresses a socket reports for a connection from this machine. */
export const isLoopbackPeer = (remoteAddress) => LOOPBACK_PEERS.has(remoteAddress);

/** True when a loopback connection is carrying a request from somewhere else. */
export const cameThroughProxy = (headers = {}) => RELAY_HEADERS.some((name) => headers[name] !== undefined);
