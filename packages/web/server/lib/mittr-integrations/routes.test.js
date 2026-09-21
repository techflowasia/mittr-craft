import { describe, expect, it, vi } from 'vitest';
import { registerMittrIntegrationsRoutes } from './routes.js';

const createResponse = () => ({
  statusCode: 200,
  payload: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.payload = payload;
    return this;
  },
});

const captureHandlers = (dependencies) => {
  const handlers = new Map();
  const app = {
    get: vi.fn((route, handler) => handlers.set(`GET ${route}`, handler)),
    put: vi.fn((route, ...rest) => handlers.set(`PUT ${route}`, rest[rest.length - 1])),
    post: vi.fn((route, handler) => handlers.set(`POST ${route}`, handler)),
  };
  registerMittrIntegrationsRoutes(app, dependencies);
  return handlers;
};

describe('mittr integrations routes', () => {
  it('GET /api/mittr/integrations returns the platform config', async () => {
    const cfg = { jira: { configured: true } };
    const mittrIntegrationsService = { getConfig: vi.fn(async () => cfg) };
    const handlers = captureHandlers({ mittrIntegrationsService });
    const res = createResponse();

    await handlers.get('GET /api/mittr/integrations')({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual(cfg);
  });

  it('PUT /api/mittr/integrations forwards the body and returns the updated config', async () => {
    const updated = { jira: { configured: true } };
    const mittrIntegrationsService = { setConfig: vi.fn(async () => updated) };
    const handlers = captureHandlers({ mittrIntegrationsService });
    const res = createResponse();
    const body = { jira: { baseUrl: 'https://x.atlassian.net' } };

    await handlers.get('PUT /api/mittr/integrations')({ body }, res);

    expect(mittrIntegrationsService.setConfig).toHaveBeenCalledWith(body);
    expect(res.payload).toEqual(updated);
  });

  it('POST jira/test and plane/test call their own service methods', async () => {
    const mittrIntegrationsService = {
      testJira: vi.fn(async () => ({ ok: true, displayName: 'Chai' })),
      testPlane: vi.fn(async () => ({ ok: true, count: 3, projects: [] })),
    };
    const handlers = captureHandlers({ mittrIntegrationsService });

    const jiraRes = createResponse();
    await handlers.get('POST /api/mittr/integrations/jira/test')({}, jiraRes);
    expect(jiraRes.payload).toEqual({ ok: true, displayName: 'Chai' });

    const planeRes = createResponse();
    await handlers.get('POST /api/mittr/integrations/plane/test')({}, planeRes);
    expect(planeRes.payload).toEqual({ ok: true, count: 3, projects: [] });
  });

  it('maps a service error to its status code', async () => {
    const error = new Error('Sign in to Mittr first');
    error.statusCode = 401;
    const mittrIntegrationsService = { getConfig: vi.fn(async () => { throw error; }) };
    const handlers = captureHandlers({ mittrIntegrationsService });
    const res = createResponse();

    await handlers.get('GET /api/mittr/integrations')({}, res);

    expect(res.statusCode).toBe(401);
    expect(res.payload).toEqual({ error: 'Sign in to Mittr first' });
  });

  it('falls back to a 500 for an unexpected failure', async () => {
    const mittrIntegrationsService = { getConfig: vi.fn(async () => { throw new Error('boom'); }) };
    const handlers = captureHandlers({ mittrIntegrationsService });
    const res = createResponse();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await handlers.get('GET /api/mittr/integrations')({}, res);

    expect(res.statusCode).toBe(500);
    consoleSpy.mockRestore();
  });
});
