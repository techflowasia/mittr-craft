import { describe, expect, it, vi } from 'vitest';
import { registerMittrWorkRoutes } from './routes.js';

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
  };
  registerMittrWorkRoutes(app, dependencies);
  return handlers;
};

describe('GET /api/mittr/work', () => {
  it('returns 401 when there is no session email', async () => {
    const mittrWorkService = { listWork: vi.fn() };
    const handlers = captureHandlers({
      uiAuthController: { getSessionEmail: vi.fn(async () => null) },
      mittrWorkService,
    });
    const handler = handlers.get('GET /api/mittr/work');
    const res = createResponse();

    await handler({}, res);

    expect(res.statusCode).toBe(401);
    expect(mittrWorkService.listWork).not.toHaveBeenCalled();
  });

  it('returns 401 when no uiAuthController is provided', async () => {
    const mittrWorkService = { listWork: vi.fn() };
    const handlers = captureHandlers({ mittrWorkService });
    const handler = handlers.get('GET /api/mittr/work');
    const res = createResponse();

    await handler({}, res);

    expect(res.statusCode).toBe(401);
  });

  it('resolves the session email server-side and returns the work items', async () => {
    const items = [{ id: 'task-1', title: 'Ship it', project: 'MittrCraft' }];
    const mittrWorkService = { listWork: vi.fn(async () => ({ configured: true, items })) };
    const getSessionEmail = vi.fn(async () => 'chaibluesky37@gmail.com');
    const handlers = captureHandlers({
      uiAuthController: { getSessionEmail },
      mittrWorkService,
    });
    const handler = handlers.get('GET /api/mittr/work');
    const res = createResponse();

    await handler({ body: { email: 'attacker@example.com' } }, res);

    expect(getSessionEmail).toHaveBeenCalledOnce();
    expect(mittrWorkService.listWork).toHaveBeenCalledWith();
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ configured: true, items });
  });

  it('reports the platform as not connected without failing the request', async () => {
    const mittrWorkService = { listWork: vi.fn(async () => ({ configured: false, items: [] })) };
    const handlers = captureHandlers({
      uiAuthController: { getSessionEmail: vi.fn(async () => 'user@example.com') },
      mittrWorkService,
    });
    const handler = handlers.get('GET /api/mittr/work');
    const res = createResponse();

    await handler({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ configured: false, items: [] });
  });

  it('maps a service error to its status code', async () => {
    const error = new Error('Session expired');
    error.statusCode = 401;
    const mittrWorkService = { listWork: vi.fn(async () => { throw error; }) };
    const handlers = captureHandlers({
      uiAuthController: { getSessionEmail: vi.fn(async () => 'user@example.com') },
      mittrWorkService,
    });
    const handler = handlers.get('GET /api/mittr/work');
    const res = createResponse();

    await handler({}, res);

    expect(res.statusCode).toBe(401);
    expect(res.payload).toEqual({ error: 'Session expired' });
  });

  it('falls back to a 500 for an unexpected failure', async () => {
    const mittrWorkService = { listWork: vi.fn(async () => { throw new Error('boom'); }) };
    const handlers = captureHandlers({
      uiAuthController: { getSessionEmail: vi.fn(async () => 'user@example.com') },
      mittrWorkService,
    });
    const handler = handlers.get('GET /api/mittr/work');
    const res = createResponse();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await handler({}, res);

    expect(res.statusCode).toBe(500);
    consoleSpy.mockRestore();
  });
});
