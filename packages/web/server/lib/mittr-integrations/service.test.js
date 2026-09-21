import { describe, expect, it, vi } from 'vitest';
import { createMittrIntegrationsService } from './service.js';

const baseUrl = 'https://platform.example.com';
const session = { accessToken: 'access-token-123' };

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('createMittrIntegrationsService', () => {
  it('reports unconfigured when the broker base URL is missing', () => {
    const service = createMittrIntegrationsService({
      ensureFreshSession: vi.fn(async () => session),
      fetchImpl: vi.fn(),
    });

    expect(service.configured).toBe(false);
  });

  it('rejects with 503 when not configured, without calling fetch', async () => {
    const fetchImpl = vi.fn();
    const service = createMittrIntegrationsService({ fetchImpl });

    await expect(service.getConfig()).rejects.toMatchObject({ statusCode: 503 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects with 401 when nobody has signed in to Mittr yet', async () => {
    const fetchImpl = vi.fn();
    const service = createMittrIntegrationsService({
      brokerBaseUrl: baseUrl,
      ensureFreshSession: vi.fn(async () => null),
      fetchImpl,
    });

    await expect(service.getConfig()).rejects.toMatchObject({ statusCode: 401 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('getConfig sends the session bearer token to /api/integrations', async () => {
    const cfg = { jira: { baseUrl: '', email: '', hasToken: false, configured: false } };
    const fetchImpl = vi.fn(async () => jsonResponse(200, cfg));
    const service = createMittrIntegrationsService({
      brokerBaseUrl: baseUrl,
      ensureFreshSession: vi.fn(async () => session),
      fetchImpl,
    });

    await expect(service.getConfig()).resolves.toEqual(cfg);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://platform.example.com/api/integrations');
    expect(options.method).toBe('GET');
    expect(options.headers.Authorization).toBe('Bearer access-token-123');
  });

  it('setConfig PUTs the given input as JSON', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));
    const service = createMittrIntegrationsService({
      brokerBaseUrl: baseUrl,
      ensureFreshSession: vi.fn(async () => session),
      fetchImpl,
    });

    await service.setConfig({ jira: { baseUrl: 'https://x.atlassian.net' } });

    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://platform.example.com/api/integrations');
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({ jira: { baseUrl: 'https://x.atlassian.net' } });
  });

  it('testJira and testPlane POST to their own endpoints', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));
    const service = createMittrIntegrationsService({
      brokerBaseUrl: baseUrl,
      ensureFreshSession: vi.fn(async () => session),
      fetchImpl,
    });

    await service.testJira();
    await service.testPlane();

    expect(fetchImpl.mock.calls[0][0]).toBe('https://platform.example.com/api/integrations/jira/test');
    expect(fetchImpl.mock.calls[1][0]).toBe('https://platform.example.com/api/integrations/plane/test');
  });

  it('surfaces the platform error message on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, { error: 'Invalid base URL' }));
    const service = createMittrIntegrationsService({
      brokerBaseUrl: baseUrl,
      ensureFreshSession: vi.fn(async () => session),
      fetchImpl,
    });

    await expect(service.setConfig({})).rejects.toMatchObject({
      statusCode: 400,
      message: 'Invalid base URL',
    });
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
    const service = createMittrIntegrationsService({
      brokerBaseUrl: baseUrl,
      ensureFreshSession: vi.fn(async () => session),
      fetchImpl,
    });

    const pending = service.getConfig();
    const assertion = expect(pending).rejects.toMatchObject({ statusCode: 504 });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    vi.useRealTimers();
  });
});
