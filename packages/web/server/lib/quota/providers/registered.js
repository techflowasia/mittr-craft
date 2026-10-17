const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/;

const entries = new Map();
const reserved = new Set();

export const registeredQuotaProviders = () => entries;

export const reserveQuotaProviderIds = (ids) => {
  for (const id of ids) {
    reserved.add(id);
    entries.delete(id);
  }
};

export const registerQuotaProvider = (entry) => {
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
  return () => {
    if (entries.get(entry.providerId) === registered) {
      entries.delete(entry.providerId);
    }
  };
};
