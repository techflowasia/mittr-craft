import { CANNOT_REACH_MITTR, PLATFORM_TIMED_OUT, PLATFORM_TIMEOUT_MS, isTimeout, platformErrorText } from './platform.js';

const WORK_ENDPOINT = '/desktop/work';

const NOT_AUTHORIZED = 'Not authorized to read work items';
const PLATFORM_UNAVAILABLE = 'Mittr platform is unavailable';
const LOAD_FAILED = 'Failed to load work items';

const NOT_CONFIGURED = { configured: false, items: [], userId: null };

const refusalTextOf = async (response) => {
  try {
    return platformErrorText(await response.json()) ?? NOT_AUTHORIZED;
  } catch {
    return NOT_AUTHORIZED;
  }
};

export function registerMittrWorkRoutes(app, {
  broker,
  ensureFreshSession,
  fetchImpl = (...args) => fetch(...args),
  logger = console,
}) {
  const configured = Boolean(broker?.baseUrl) && Boolean(ensureFreshSession);
  const endpoint = configured ? new URL(WORK_ENDPOINT, broker.baseUrl).toString() : null;
  const failure = (res, status, error) => res.status(status).json({ error });

  app.get('/api/mittr/work', async (_req, res) => {
    try {
      if (!configured) return res.json(NOT_CONFIGURED);
      const session = await ensureFreshSession();
      if (!session?.accessToken) return res.json(NOT_CONFIGURED);
      const userId = session.subject?.userId ?? null;

      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'GET',
          headers: { authorization: `Bearer ${session.accessToken}` },
          signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
        });
      } catch (error) {
        if (isTimeout(error)) return failure(res, 504, PLATFORM_TIMED_OUT);
        logger.error('[mittr] work items could not be read:', error?.name ?? 'error');
        return failure(res, 502, CANNOT_REACH_MITTR);
      }

      if (response.status === 401 || response.status === 403) {
        return failure(res, response.status, await refusalTextOf(response));
      }
      if (response.status >= 500) return failure(res, 503, PLATFORM_UNAVAILABLE);
      if (!response.ok) return failure(res, response.status, LOAD_FAILED);

      let body = null;
      try {
        body = await response.json();
      } catch (error) {
        if (isTimeout(error)) return failure(res, 504, PLATFORM_TIMED_OUT);
      }
      return res.json({ configured: true, items: Array.isArray(body?.items) ? body.items : [], userId });
    } catch (error) {
      logger.error('[mittr] work items could not be loaded:', error?.name ?? 'error');
      return failure(res, 500, LOAD_FAILED);
    }
  });
}
