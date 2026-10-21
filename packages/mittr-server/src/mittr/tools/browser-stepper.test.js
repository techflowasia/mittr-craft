import assert from 'node:assert/strict';
import test from 'node:test';

import { ACCOUNT_CHANGED, BROWSER_STEP_TIMEOUT_MS, CANNOT_REACH_MITTR } from '../platform.js';
import { fakeFetch, json } from '../test-helpers.js';
import { createBrowserStepper } from './browser-stepper.js';

const BROKER = { baseUrl: 'https://platform.example.test' };
const SESSION = { accessToken: 'at-step-1', subject: { userId: 'u-1' } };

const stepperWith = (respond, { session = SESSION, onActiveHome = () => true, ...options } = {}) => {
  const fetchImpl = fakeFetch(respond);
  const stepper = createBrowserStepper({ broker: BROKER, ensureFreshSession: async () => session, fetchImpl, engineOnActiveHome: () => onActiveHome(), ...options });
  return { stepper, fetchImpl };
};

const refusal = (statusCode, message) => (error) => {
  assert.equal(error.message, message);
  assert.equal(error.statusCode, statusCode);
  return true;
};

const ASK = { goal: 'Send the form as Somchai', snapshot: '- textbox "Name" [ref=e1]', history: [] };

test('the step timeout is the decision model\'s 30 seconds', () => {
  assert.equal(BROWSER_STEP_TIMEOUT_MS, 30_000);
});

test('a step is asked of the platform with the active account\'s bearer and read back', async () => {
  const { stepper, fetchImpl } = stepperWith(() => json({ step: { action: 'fill', ref: 'e1', target: 'textbox "Name"', value: 'Somchai' }, values: ['Somchai', 7], decidedBy: ['jev', 3], ms: 41 }));
  const reply = await stepper.nextStep({ ...ASK, history: ['click button "Start"'], values: ['Somchai'] });
  assert.deepEqual(reply, { step: { action: 'fill', ref: 'e1', target: 'textbox "Name"', value: 'Somchai' }, values: ['Somchai'], decidedBy: ['jev'], ms: 41 });
  const [call] = fetchImpl.calls;
  assert.equal(call.url, 'https://platform.example.test/desktop/browser/next-step');
  assert.equal(call.method, 'POST');
  assert.deepEqual(call.headers, { authorization: 'Bearer at-step-1', 'content-type': 'application/json' });
  assert.deepEqual(call.body, { goal: ASK.goal, snapshot: ASK.snapshot, history: ['click button "Start"'], values: ['Somchai'] });
});

test('values are sent only when there are some, and a reply without them has none', async () => {
  const { stepper, fetchImpl } = stepperWith(() => json({ step: { action: 'done' }, decidedBy: 'jev', ms: 'fast' }));
  assert.deepEqual(await stepper.nextStep(ASK), { step: { action: 'done' }, values: undefined, decidedBy: [], ms: null });
  assert.equal(Object.hasOwn(fetchImpl.calls[0].body, 'values'), false);
});

test('only a complete step from the fixed set is used', async () => {
  for (const step of [
    null,
    'click',
    { action: 'type', ref: 'e1', value: 'x' },
    { action: 'click' },
    { action: 'click', ref: '@e1' },
    { action: 'click', ref: 'e1; rm' },
    { action: 'fill', ref: 'e2' },
    { action: 'select', ref: 'e2', value: 3 },
  ]) {
    const { stepper } = stepperWith(() => json({ step }));
    await assert.rejects(stepper.nextStep(ASK), refusal(502, 'The Mittr platform returned no usable step'), JSON.stringify(step));
  }
  const { stepper } = stepperWith(() => new Response('not json', { status: 200 }));
  await assert.rejects(stepper.nextStep(ASK), refusal(502, 'The Mittr platform returned no usable step'));
  for (const step of [{ action: 'click', ref: 'e3' }, { action: 'fill', ref: 'e2', value: '' }, { action: 'ask', question: 'Which one?' }, { action: 'stop', reason: 'blocked' }]) {
    const { stepper: good } = stepperWith(() => json({ step }));
    assert.deepEqual((await good.nextStep(ASK)).step, step);
  }
});

test('no session answers sign in first and calls nothing', async () => {
  const { stepper, fetchImpl } = stepperWith(() => json({}), { session: null });
  await assert.rejects(stepper.nextStep(ASK), refusal(401, 'Sign in to Mittr first'));
  assert.equal(fetchImpl.calls.length, 0);
});

test('a slow platform answers 504 after the step timeout, and an unreachable one 502', async () => {
  const fetchImpl = async (_url, init) => new Promise((_resolve, reject) => {
    if (init.signal.aborted) reject(init.signal.reason);
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  const slow = createBrowserStepper({ broker: BROKER, ensureFreshSession: async () => SESSION, fetchImpl, engineOnActiveHome: () => true, timeoutMs: 20 });
  await assert.rejects(slow.nextStep(ASK), refusal(504, 'The Mittr platform took too long to choose a step'));
  const { stepper } = stepperWith(() => { throw new TypeError('fetch failed'); });
  await assert.rejects(stepper.nextStep(ASK), refusal(502, CANNOT_REACH_MITTR));
});

test('the platform\'s own message passes through with its status', async () => {
  const { stepper } = stepperWith(() => json({ statusCode: 400, error: 'Bad Request', message: 'goal must not be empty' }, 400));
  await assert.rejects(stepper.nextStep(ASK), refusal(400, 'goal must not be empty'));
  const { stepper: quota } = stepperWith(() => json({ error: 'Weekly quota used up' }, 429));
  await assert.rejects(quota.nextStep(ASK), refusal(429, 'Weekly quota used up'));
  const { stepper: bare } = stepperWith(() => json(null, 503));
  await assert.rejects(bare.nextStep(ASK), refusal(503, 'HTTP 503'));
});

test('a cancelled call stops waiting for the platform', async () => {
  const controller = new AbortController();
  const fetchImpl = async (_url, init) => new Promise((_resolve, reject) => {
    if (init.signal.aborted) reject(init.signal.reason);
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  const stepper = createBrowserStepper({ broker: BROKER, ensureFreshSession: async () => SESSION, fetchImpl, engineOnActiveHome: () => true });
  const asked = stepper.nextStep(ASK, controller.signal);
  controller.abort();
  await assert.rejects(asked, (error) => error.statusCode === 499);
});

test('a page is never sent while the engine is not on the active account, and a step chosen across a switch is not used', async () => {
  const before = stepperWith(() => json({ step: { action: 'done' } }), { onActiveHome: () => false });
  await assert.rejects(before.stepper.nextStep(ASK), refusal(409, ACCOUNT_CHANGED));
  assert.equal(before.fetchImpl.calls.length, 0);

  const state = { settled: true };
  const during = stepperWith(() => {
    state.settled = false;
    return json({ step: { action: 'click', ref: 'e1' } });
  }, { onActiveHome: () => state.settled });
  await assert.rejects(during.stepper.nextStep(ASK), refusal(409, ACCOUNT_CHANGED));
  assert.equal(during.fetchImpl.calls.length, 1);
  assert.equal(ACCOUNT_CHANGED, 'The Mittr account changed');
});

test('without a platform, a session source or an account guard there is no stepper', () => {
  const ensureFreshSession = async () => SESSION;
  const engineOnActiveHome = () => true;
  assert.equal(createBrowserStepper({ broker: { baseUrl: null }, ensureFreshSession, engineOnActiveHome }), null);
  assert.equal(createBrowserStepper({ broker: BROKER, engineOnActiveHome }), null);
  assert.equal(createBrowserStepper({ broker: BROKER, ensureFreshSession }), null);
  assert.equal(createBrowserStepper(), null);
});

test('the access token appears in no error', async () => {
  for (const respond of [() => json({ message: 'nope' }, 401), () => { throw new TypeError('fetch failed'); }, () => json({ step: {} })]) {
    const { stepper } = stepperWith(respond);
    await assert.rejects(stepper.nextStep(ASK), (error) => !JSON.stringify({ message: error.message, ...error }).includes(SESSION.accessToken));
  }
});
