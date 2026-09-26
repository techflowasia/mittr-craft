import { createMittrWorkService } from './service.js';

export const registerMittrWorkRoutes = (app, dependencies) => {
  const {
    brokerBaseUrl,
    ensureFreshSession,
    fetchImpl,
    mittrWorkService = createMittrWorkService({ brokerBaseUrl, ensureFreshSession, fetchImpl }),
  } = dependencies;

  app.get('/api/mittr/work', async (_req, res) => {
    try {
      const result = await mittrWorkService.listWork();
      return res.json(result);
    } catch (error) {
      if (error?.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error('[MittrWork] failed to load work items:', error);
      return res.status(500).json({ error: 'Failed to load work items' });
    }
  });
};
