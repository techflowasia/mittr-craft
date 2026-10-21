import { callPlatform, platformErrorText } from './platform.js';

const WORK_ENDPOINT = '/desktop/work';

const NOT_AUTHORIZED = 'Not authorized to read work items';
const PLATFORM_UNAVAILABLE = 'Mittr platform is unavailable';
const LOAD_FAILED = 'Failed to load work items';

const NOT_CONFIGURED = { configured: false, items: [], userId: null };

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

      const { response, body, failure: unreached, cause } = await callPlatform(fetchImpl, endpoint, { accessToken: session.accessToken });
      if (unreached) {
        if (unreached.status === 502) logger.error('[mittr] work items could not be read:', cause?.name ?? 'error');
        return failure(res, unreached.status, unreached.error);
      }

      if (response.status === 401 || response.status === 403) {
        return failure(res, response.status, platformErrorText(body) ?? NOT_AUTHORIZED);
      }
      if (response.status >= 500) return failure(res, 503, PLATFORM_UNAVAILABLE);
      if (!response.ok) return failure(res, response.status, LOAD_FAILED);

      return res.json({ configured: true, items: Array.isArray(body?.items) ? body.items : [], userId });
    } catch (error) {
      logger.error('[mittr] work items could not be loaded:', error?.name ?? 'error');
      return failure(res, 500, LOAD_FAILED);
    }
  });
}
