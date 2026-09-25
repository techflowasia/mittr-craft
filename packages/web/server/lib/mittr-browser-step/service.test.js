import { describe, expect, it, vi } from 'vitest';

import { createMittrBrowserStepper } from './service.js';

const session = { accessToken: 'token-1' };

const stepperWith = (response, { ensureFreshSession = async () => session } = {}) => {
  const fetchImpl = vi.fn(async () => response);
  const stepper = createMittrBrowserStepper({ brokerBaseUrl: 'https://api.example/', ensureFreshSession, fetchImpl });
  return { stepper, fetchImpl };
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

describe('createMittrBrowserStepper', () => {
  it('is absent when this install cannot reach the platform', () => {
    expect(createMittrBrowserStepper({})).toBeNull();
  });

  it('posts the page and the steps so far with the desktop session', async () => {
    const { stepper, fetchImpl } = stepperWith(json({ step: { action: 'click', ref: 'e3', target: 'button "ส่ง"' }, decidedBy: ['m'], ms: 300 }));
    const reply = await stepper.nextStep({ goal: 'ส่ง', snapshot: '- button "ส่ง" [ref=e3]', history: [] });
    expect(reply.step).toMatchObject({ action: 'click', ref: 'e3' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example/desktop/browser/next-step');
    expect(init.headers.Authorization).toBe('Bearer token-1');
    expect(JSON.parse(init.body)).toEqual({ goal: 'ส่ง', snapshot: '- button "ส่ง" [ref=e3]', history: [] });
  });

  it('refuses a step that points at no element or carries no value', async () => {
    await expect(stepperWith(json({ step: { action: 'click' } })).stepper.nextStep({ goal: 'x', snapshot: '', history: [] }))
      .rejects.toMatchObject({ statusCode: 502 });
    await expect(stepperWith(json({ step: { action: 'fill', ref: 'e1' } })).stepper.nextStep({ goal: 'x', snapshot: '', history: [] }))
      .rejects.toMatchObject({ statusCode: 502 });
  });

  it('asks the person to sign in when there is no session', async () => {
    const { stepper } = stepperWith(json({}), { ensureFreshSession: async () => null });
    await expect(stepper.nextStep({ goal: 'x', snapshot: '', history: [] })).rejects.toMatchObject({ statusCode: 401 });
  });

  it('passes the platform’s own error through', async () => {
    const { stepper } = stepperWith(json({ message: 'desktop_session_required' }, 403));
    await expect(stepper.nextStep({ goal: 'x', snapshot: '', history: [] }))
      .rejects.toMatchObject({ statusCode: 403, message: 'desktop_session_required' });
  });
});
