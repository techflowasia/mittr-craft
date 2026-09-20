const REQUEST_TIMEOUT_MS = 10_000;

const readNonEmpty = (env, key) => {
  const value = env?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
};

const normalizeBaseUrl = (baseUrl) => baseUrl.replace(/\/+$/, '');

const createHttpError = (message, statusCode) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

export const createMittrWorkService = ({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) => {
  void now;

  const baseUrl = readNonEmpty(env, 'MITTR_PLATFORM_BASE_URL');
  const serviceKey = readNonEmpty(env, 'MITTR_PLATFORM_SERVICE_KEY');
  const configured = Boolean(baseUrl && serviceKey);

  const listWork = async (email) => {
    if (!configured) {
      return { configured: false, items: [] };
    }

    const normalizedEmail = typeof email === 'string' ? email.trim() : '';
    if (!normalizedEmail) {
      throw createHttpError('email is required', 400);
    }

    const url = `${normalizeBaseUrl(baseUrl)}/desktop/work?email=${encodeURIComponent(normalizedEmail)}`;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${serviceKey}`,
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
