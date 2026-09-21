import express from 'express';
import { createMittrIntegrationsService } from './service.js';

// The application does not parse JSON globally -- every route that needs a body declares its
// own parser, so a route that assumes a parsed body reads undefined on the real server while
// passing every test whose harness happened to add one.
const readJson = express.json({ limit: '16kb' });

const send = (res, promise) => promise.then(
  (body) => res.json(body),
  (error) => {
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error('[MittrIntegrations] request failed:', error);
    return res.status(500).json({ error: 'Request failed' });
  },
);

export const registerMittrIntegrationsRoutes = (app, dependencies) => {
  const {
    brokerBaseUrl,
    ensureFreshSession,
    fetchImpl,
    mittrIntegrationsService = createMittrIntegrationsService({ brokerBaseUrl, ensureFreshSession, fetchImpl }),
  } = dependencies;

  app.get('/api/mittr/integrations', (_req, res) => {
    void send(res, mittrIntegrationsService.getConfig());
  });

  app.put('/api/mittr/integrations', readJson, (req, res) => {
    void send(res, mittrIntegrationsService.setConfig(req.body ?? {}));
  });

  app.post('/api/mittr/integrations/jira/test', (_req, res) => {
    void send(res, mittrIntegrationsService.testJira());
  });

  app.post('/api/mittr/integrations/plane/test', (_req, res) => {
    void send(res, mittrIntegrationsService.testPlane());
  });
};
