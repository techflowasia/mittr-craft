import { READ_FAILED } from './platform.js';

export function registerMittrQuotaRoutes(app, { service }) {
  app.get('/api/mittr/quota/me', async (_req, res) => {
    try {
      return res.json(await service.readMine());
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502;
      const reasonCode = typeof error?.reasonCode === 'string' ? error.reasonCode : 'upstream_failed';
      return res.status(status).json({ error: READ_FAILED, reasonCode });
    }
  });
}
