import { createMittrQuotaService } from './service.js';

export const registerMittrQuotaRoutes = (app, dependencies) => {
  const {
    brokerBaseUrl,
    ensureFreshSession,
    fetchImpl,
    mittrQuotaService = createMittrQuotaService({ brokerBaseUrl, ensureFreshSession, fetchImpl }),
  } = dependencies;

  app.get('/api/mittr/quota/me', async (_req, res) => {
    try {
      return res.json(await mittrQuotaService.readMine());
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502;
      const reasonCode = typeof error?.reasonCode === 'string' ? error.reasonCode : 'upstream_failed';
      return res.status(status).json({ error: 'Could not read this week’s quota', reasonCode });
    }
  });
};

export const registerMittrAnsweredByRoutes = (app, { answeredByLog, now = Date.now }) => {
  app.get('/api/mittr/answered-by', (req, res) => {
    const sessionId = typeof req.query?.sessionId === 'string' ? req.query.sessionId.trim() : '';
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required', reasonCode: 'invalid_request' });
    }
    return res.json({
      now: now(),
      answers: answeredByLog.list(sessionId).map(({ at, model, reason, requestedLabel, answeredLabel }) => ({
        at, model, reason, requestedLabel, answeredLabel,
      })),
    });
  });
};
