import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { MittrCraftControlError } from './error.js';
import { registerMittrCraftControlRoutes } from './routes.js';

const createApp = (execute) => {
  const app = express();
  registerMittrCraftControlRoutes(app, { controlService: { execute } });
  return app;
};

describe('MittrCraft control route', () => {
  it('is a thin adapter over the control service', async () => {
    const execute = vi.fn(async () => ({ projects: [] }));
    const response = await request(createApp(execute))
      .post('/api/mittrcraft/control')
      .send({ action: 'projects.list', input: {}, contextDirectory: '/repo' })
      .expect(200);
    expect(response.body).toEqual({ projects: [] });
    expect(execute).toHaveBeenCalledWith('projects.list', {}, '/repo', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('preserves service status and partial-result details', async () => {
    const execute = vi.fn(async () => {
      throw new MittrCraftControlError('dispatch failed', 500, {
        partial: true,
        partialAction: 'fork-created',
        sessionId: 'ses_fork',
        directory: '/repo',
      });
    });
    const response = await request(createApp(execute))
      .post('/api/mittrcraft/control')
      .send({ action: 'session.fork', input: {} })
      .expect(500);
    expect(response.body).toEqual({
      error: 'dispatch failed',
      partial: true,
      partialAction: 'fork-created',
      sessionId: 'ses_fork',
      directory: '/repo',
    });
  });
});

describe('Chrome profiles route', () => {
  it('lists Chrome profiles for the settings screen', async () => {
    const app = express();
    registerMittrCraftControlRoutes(app, { controlService: { execute: vi.fn(), chromeProfiles: vi.fn(async () => [{ directory: 'Default', name: 'Your Chrome' }]) } });
    const response = await request(app).get('/api/mittrcraft/chrome/profiles');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ profiles: [{ directory: 'Default', name: 'Your Chrome' }] });
  });
});

describe('Chrome approved hosts route', () => {
  it('removes one host through the service and returns the list that remains', async () => {
    const app = express();
    const removeChromeHost = vi.fn(async () => ['plane.techflow.asia']);
    registerMittrCraftControlRoutes(app, { controlService: { execute: vi.fn(), removeChromeHost } });
    const response = await request(app).delete('/api/mittrcraft/chrome/approved-hosts/github.com');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ hosts: ['plane.techflow.asia'] });
    expect(removeChromeHost).toHaveBeenCalledWith('github.com');
  });
});
