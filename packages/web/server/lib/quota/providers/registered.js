const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/;

const entries = new Map();
const reserved = new Set();
const exclusive = new Set();

export const registeredQuotaProviders = () => entries;

export const builtInQuotaProvidersShown = () => exclusive.size === 0;

export const reserveQuotaProviderIds = (ids) => {
  for (const id of ids) {
    reserved.add(id);
    entries.delete(id);
  }
};

export const registerQuotaProvider = (entry, options) => {
  if (!entry || typeof entry.providerId !== 'string' || !PROVIDER_ID.test(entry.providerId)
    || typeof entry.isConfigured !== 'function' || typeof entry.fetchQuota !== 'function') {
    throw new TypeError('A quota provider needs a providerId of lowercase letters, digits and dashes, isConfigured() and fetchQuota()');
  }
  if (reserved.has(entry.providerId) || entries.has(entry.providerId)) {
    throw new Error(`Quota provider ${entry.providerId} is already registered`);
  }
  const registered = {
    providerId: entry.providerId,
    providerName: entry.providerName,
    isConfigured: entry.isConfigured,
    fetchQuota: entry.fetchQuota
  };
  entries.set(entry.providerId, registered);
  if (options?.exclusive === true) exclusive.add(registered);
  return () => {
    exclusive.delete(registered);
    if (entries.get(entry.providerId) === registered) {
      entries.delete(entry.providerId);
    }
  };
};
