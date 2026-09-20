import { describe, expect, it, vi } from 'vitest';
import { createMittrWorkService } from './service.js';

const baseEnv = {
  MITTR_PLATFORM_BASE_URL: 'https://platform.example.com',
  MITTR_PLATFORM_SERVICE_KEY: 'secret-key',
};

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('createMittrWorkService configuration', () => {
  it('reports unconfigured when the base URL is missing', async () => {
    const service = createMittrWorkService({
      env: { MITTR_PLATFORM_SERVICE_KEY: 'secret-key' },
      fetchImpl: vi.fn(),
    });

    expect(service.configured).toBe(false);
    await expect(service.listWork('user@example.com')).resolves.toEqual({ configured: false, items: [] });
  });

  it('reports unconfigured when the service key is missing', async () => {
    const service = createMittrWorkService({
      env: { MITTR_PLATFORM_BASE_URL: 'https://platform.example.com' },
      fetchImpl: vi.fn(),
    });

    expect(service.configured).toBe(false);
    await expect(service.listWork('user@example.com')).resolves.toEqual({ configured: false, items: [] });
  });
});

describe('createMittrWorkService listWork', () => {
  it('requests the desktop work endpoint with the bearer key and urlencoded email', async () => {
    const items = [{
      id: 'task-1',
      title: 'Ship the panel',
      project: 'MittrCraft',
      phase: 'Build',
      state: 'in_progress',
      priority: 'high',
      due: '2026-09-25',
      estimate: '3',
      url: 'https://platform.example.com/tasks/task-1',
      updatedAt: '2026-09-19T10:00:00.000Z',
    }];
    const fetchImpl = vi.fn(async () => jsonResponse(200, { items }));
    const service = createMittrWorkService({ env: baseEnv, fetchImpl });

    const result = await service.listWork('chai bluesky+test@example.com');

    expect(result).toEqual({ configured: true, items });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://platform.example.com/desktop/work?email=${encodeURIComponent('chai bluesky+test@example.com')}`);
    expect(options.headers.Authorization).toBe('Bearer secret-key');
  });

  it('maps a missing items array to an empty list', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    const service = createMittrWorkService({ env: baseEnv, fetchImpl });

    await expect(service.listWork('user@example.com')).resolves.toEqual({ configured: true, items: [] });
  });

  it('surfaces a 401 as an authorization error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: 'Session expired' }));
    const service = createMittrWorkService({ env: baseEnv, fetchImpl });

    await expect(service.listWork('user@example.com')).rejects.toMatchObject({
      statusCode: 401,
      message: 'Session expired',
    });
  });

  it('surfaces a 403 as an authorization error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(403, { error: 'Not entitled' }));
    const service = createMittrWorkService({ env: baseEnv, fetchImpl });

    await expect(service.listWork('user@example.com')).rejects.toMatchObject({
      statusCode: 403,
      message: 'Not entitled',
    });
  });

  it('maps a 5xx response to an unavailable error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: 'boom' }));
    const service = createMittrWorkService({ env: baseEnv, fetchImpl });

    await expect(service.listWork('user@example.com')).rejects.toMatchObject({ statusCode: 503 });
  });

  it('times out slow requests after 10 seconds', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }));
    const service = createMittrWorkService({ env: baseEnv, fetchImpl });

    const pending = service.listWork('user@example.com');
    const assertion = expect(pending).rejects.toMatchObject({ statusCode: 504 });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    vi.useRealTimers();
  });

  it('rejects when no email is provided', async () => {
    const service = createMittrWorkService({ env: baseEnv, fetchImpl: vi.fn() });

    await expect(service.listWork('')).rejects.toMatchObject({ statusCode: 400 });
  });
});
