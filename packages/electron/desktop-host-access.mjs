const displayUrl = (value) => {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'relay:'].includes(url.protocol)) return '';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
};

export const desktopHostsForSender = (config, localOrigin, trusted) => {
  if (trusted) return { ...config, localOrigin, access: 'full' };
  return {
    access: 'metadata',
    hosts: config.hosts.map((host) => ({
      id: host.id,
      label: /:\/\//.test(host.label) ? displayUrl(host.label) : host.label,
      url: displayUrl(host.url),
      ...(host.apiUrl ? { apiUrl: displayUrl(host.apiUrl) } : {}),
      access: 'metadata',
      hasRelay: Boolean(host.relay),
    })),
    defaultHostId: config.defaultHostId,
    initialHostChoiceCompleted: config.initialHostChoiceCompleted,
    localOrigin: displayUrl(localOrigin),
  };
};

export const resolveSavedDesktopHost = (config, hostId, localOrigin, localClientToken) => {
  if (typeof hostId !== 'string' || !hostId.trim()) throw new Error('Host id is required');
  if (hostId === 'local') {
    if (!localOrigin) throw new Error('Local runtime is not available');
    return { id: 'local', url: localOrigin, apiUrl: localOrigin, clientToken: localClientToken, requestHeaders: {} };
  }
  const host = config.hosts.find((entry) => entry.id === hostId);
  if (!host) throw new Error('Host not found');
  return host;
};

export const probeSavedDesktopHost = async (host, probe) => {
  const url = host.apiUrl || (host.relay ? '' : host.url);
  if (!url) return { status: 'relay-unavailable', latencyMs: 0 };
  const result = await probe(url, 2_000, host.clientToken || '', host.requestHeaders || {}, host.relay?.serverId || '');
  if (host.relay && ['unreachable', 'wrong-service', 'incompatible'].includes(result.status)) {
    return { status: 'relay-unavailable', latencyMs: result.latencyMs };
  }
  return result;
};

export const savedDesktopHostNavigationUrl = (localUiUrl, hostId) => {
  if (!localUiUrl) throw new Error('Local UI is not available');
  const url = new URL(localUiUrl);
  url.searchParams.set('desktopHostId', hostId);
  return url.toString();
};
