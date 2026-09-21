const REQUEST_TIMEOUT_MS = 10_000;

const createHttpError = (message, statusCode) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

/**
 * Reuses the same Mittr desktop session that already gates the rest of the
 * app (MittrSignInGate) and already authorises the model catalog and audit
 * routes. A person who can use MittrCraft at all has already signed in to
 * Mittr as themselves, so this needs nothing an admin has to configure and
 * nothing a person has to connect separately: the platform resolves the
 * work items for whoever the access token says they are.
 */
export const createMittrWorkService = ({
  brokerBaseUrl,
  ensureFreshSession,
  fetchImpl = globalThis.fetch,
} = {}) => {
  const configured = Boolean(brokerBaseUrl && typeof ensureFreshSession === 'function');

  const listWork = async () => {
    if (!configured) {
      return { configured: false, items: [] };
    }

    const session = await ensureFreshSession();
    if (!session) {
      return { configured: false, items: [] };
    }

    const url = new URL('/desktop/work', brokerBaseUrl).toString();
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
        },
        signal: controller.signal,
      });

      if (response.status === 401 || response.status === 403) {
        const body = await response.json().catch(() => null);
        throw createHttpError(
          typeof body?.error === 'string' && body.error ? body.error : 'Not authorized to read work items',
          response.status,
        );
      }

      if (response.status >= 500) {
        throw createHttpError('Mittr platform is unavailable', 503);
      }

      if (!response.ok) {
        throw createHttpError('Failed to load work items', response.status);
      }

      const body = await response.json().catch(() => null);
      const items = Array.isArray(body?.items) ? body.items : [];
      return { configured: true, items };
    } catch (error) {
      if (typeof error?.statusCode === 'number') {
        throw error;
      }
      if (error?.name === 'AbortError') {
        throw createHttpError('Mittr platform request timed out', 504);
      }
      throw createHttpError(error instanceof Error ? error.message : 'Failed to load work items', 502);
    } finally {
      clearTimeout(timeoutHandle);
    }
  };

  return {
    configured,
    listWork,
  };
};
