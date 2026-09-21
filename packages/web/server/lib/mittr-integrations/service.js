const REQUEST_TIMEOUT_MS = 10_000;

const createHttpError = (message, statusCode) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

/**
 * Read/write a person's own Plane and Jira credentials on the Mittr platform, using the
 * same desktop session that already gates the app (MittrSignInGate) and already authorises
 * the model catalog, audit, and My work routes. No separate connection step, no admin
 * capability needed -- these are the platform's per-user settings, scoped to whoever the
 * session's access token identifies.
 */
export const createMittrIntegrationsService = ({
  brokerBaseUrl,
  ensureFreshSession,
  fetchImpl = globalThis.fetch,
} = {}) => {
  const configured = Boolean(brokerBaseUrl && typeof ensureFreshSession === 'function');

  const authorized = async (path, init) => {
    if (!configured) {
      throw createHttpError('Mittr platform is not reachable from this install', 503);
    }
    const session = await ensureFreshSession();
    if (!session) {
      throw createHttpError('Sign in to Mittr first', 401);
    }
    const url = new URL(path, brokerBaseUrl).toString();
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          Authorization: `Bearer ${session.accessToken}`,
        },
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const message = typeof body?.error === 'string' && body.error
          ? body.error
          : typeof body?.message === 'string' && body.message
            ? body.message
            : `HTTP ${response.status}`;
        throw createHttpError(message, response.status);
      }
      return body;
    } catch (error) {
      if (typeof error?.statusCode === 'number') throw error;
      if (error?.name === 'AbortError') {
        throw createHttpError('Mittr platform request timed out', 504);
      }
      throw createHttpError(error instanceof Error ? error.message : 'Request failed', 502);
    } finally {
      clearTimeout(timeoutHandle);
    }
  };

  const getConfig = () => authorized('/api/integrations', { method: 'GET' });

  const setConfig = (input) => authorized('/api/integrations', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });

  const testJira = () => authorized('/api/integrations/jira/test', { method: 'POST' });
  const testPlane = () => authorized('/api/integrations/plane/test', { method: 'POST' });

  return { configured, getConfig, setConfig, testJira, testPlane };
};
