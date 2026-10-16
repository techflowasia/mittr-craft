// Deep-link hosts that in-process server plugins own. The app's own hosts stay
// with its dispatcher and can never be registered here, so a plugin cannot
// take over a link the app already understands.
const APP_HOSTS = new Set(['connect', 'focus', 'session', 'host']);

const normalizeHost = (host) => (typeof host === 'string' ? host.trim().toLowerCase() : '');

export function createDeepLinkRegistry({ onEmit, onError } = {}) {
  const handlers = new Map();

  const register = (registration) => {
    const host = normalizeHost(registration?.host);
    if (!host) throw new TypeError('A deep-link registration needs a host');
    if (APP_HOSTS.has(host)) throw new Error(`deep-link host "${registration.host}" belongs to the app`);
    if (typeof registration.handle !== 'function') throw new TypeError(`deep-link host "${host}" needs a handle function`);
    // A server that restarts in the same process registers again before the
    // old plugin's unregister runs; the newest handler owns the host, and the
    // older unregister then leaves it alone.
    const entry = { handle: registration.handle };
    handlers.set(host, entry);
    return () => {
      if (handlers.get(host) === entry) handlers.delete(host);
    };
  };

  // Resolves true when a registered handler owns the link's host, even if it
  // threw: the link is theirs, and falling through to the app would only log
  // an unknown action.
  const dispatch = async (link) => {
    const entry = handlers.get(normalizeHost(link?.type));
    if (!entry) return false;
    try {
      const result = await entry.handle(link);
      if (typeof result?.emit === 'string' && result.emit) onEmit?.(result.emit);
    } catch (error) {
      onError?.(error, link);
    }
    return true;
  };

  return { register, dispatch };
}
