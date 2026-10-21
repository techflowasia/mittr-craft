import { INVALID_BODY, jsonBody } from './json-body.js';
import { CANNOT_REACH_MITTR, PLATFORM_TIMED_OUT, PLATFORM_TIMEOUT_MS, isTimeout, platformErrorText } from './platform.js';
import { isRecord } from './values.js';

const INTEGRATIONS_ENDPOINT = '/api/integrations';
const MOUNT = '/api/mittr/integrations';
const BODY_LIMIT = '16kb';

const NOT_REACHABLE = 'Mittr platform is not reachable from this install';
const SIGN_IN_FIRST = 'Sign in to Mittr first';
const ACCOUNT_CHANGED = 'The Mittr account changed. Open the settings again.';
const REQUEST_FAILED = 'Request failed';

const refusal = (status, error) => ({ refusal: { status, error } });

const JIRA_FIELDS = ['baseUrl', 'email', 'hasToken', 'configured'];
const PLANE_FIELDS = ['baseUrl', 'workspaceSlug', 'hasApiKey', 'configured'];
const JIRA_INPUT_FIELDS = ['baseUrl', 'email', 'token'];
const PLANE_INPUT_FIELDS = ['baseUrl', 'workspaceSlug', 'workspaceSlugs', 'apiKey'];

const BLOCKS = [['jira', JIRA_INPUT_FIELDS], ['plane', PLANE_INPUT_FIELDS]];

const pick = (source, fields) => {
  const picked = {};
  for (const name of fields) {
    if (source[name] !== undefined) picked[name] = source[name];
  }
  return picked;
};

const jiraOut = (block) => (isRecord(block) ? pick(block, JIRA_FIELDS) : undefined);

const planeOut = (block) => {
  if (!isRecord(block)) return undefined;
  const picked = pick(block, PLANE_FIELDS);
  if (Array.isArray(block.workspaceSlugs)) picked.workspaceSlugs = block.workspaceSlugs;
  return picked;
};

const configReply = (body, userId) => ({ jira: jiraOut(body?.jira), plane: planeOut(body?.plane), userId });

const TEST_FIELDS = ['ok', 'error', 'displayName', 'email', 'count'];
const WORKSPACE_TEST_FIELDS = ['slug', 'ok', 'count', 'error'];

const testReply = (body, userId) => {
  const reply = isRecord(body) ? pick(body, TEST_FIELDS) : {};
  if (Array.isArray(body?.workspaces)) {
    reply.workspaces = body.workspaces.map((entry) => (isRecord(entry) ? pick(entry, WORKSPACE_TEST_FIELDS) : null));
  }
  reply.userId = userId;
  return reply;
};

export function registerMittrIntegrationsRoutes(app, {
  express,
  broker,
  ensureFreshSession,
  fetchImpl = (...args) => fetch(...args),
  logger = console,
}) {
  const configured = Boolean(broker?.baseUrl) && Boolean(ensureFreshSession);
  const urlOf = (subpath) => new URL(`${INTEGRATIONS_ENDPOINT}${subpath}`, broker.baseUrl).toString();

  const route = (method, subpath, prepare) => {
    const label = `${method} ${MOUNT}${subpath}`;
    const answer = (res, status, error) => res.status(status).json({ error });
    const failed = (res, status, error) => {
      logger.error(`[mittr] work tracking request failed: ${label} ${status}`);
      return answer(res, status, error);
    };

    return async (req, res) => {
      try {
        if (!configured) return answer(res, 503, NOT_REACHABLE);
        const session = await ensureFreshSession();
        if (!session?.accessToken) return answer(res, 401, SIGN_IN_FIRST);
        const userId = session.subject?.userId ?? null;

        const plan = prepare(req, userId);
        if (plan.refusal) return answer(res, plan.refusal.status, plan.refusal.error);

        const headers = { authorization: `Bearer ${session.accessToken}` };
        if (plan.body) headers['content-type'] = 'application/json';

        let response;
        let body = null;
        try {
          response = await fetchImpl(urlOf(subpath), {
            method,
            headers,
            body: plan.body ? JSON.stringify(plan.body) : undefined,
            signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
          });
          body = await response.json().catch((error) => {
            if (isTimeout(error)) throw error;
            return null;
          });
        } catch (error) {
          return isTimeout(error) ? failed(res, 504, PLATFORM_TIMED_OUT) : failed(res, 502, CANNOT_REACH_MITTR);
        }

        if (!response.ok) return answer(res, response.status, platformErrorText(body) ?? `HTTP ${response.status}`);
        return res.json(plan.reply(body, userId));
      } catch {
        return failed(res, 500, REQUEST_FAILED);
      }
    };
  };

  const read = () => ({ reply: configReply });

  const save = (req, userId) => {
    const body = req.body;
    const expected = body?.expectUserId;
    if (!isRecord(body) || expected?.constructor !== String || !expected) return refusal(400, INVALID_BODY);
    const forwarded = {};
    for (const [name, fields] of BLOCKS) {
      if (!Object.hasOwn(body, name)) continue;
      if (!isRecord(body[name])) return refusal(400, INVALID_BODY);
      forwarded[name] = pick(body[name], fields);
    }
    if (expected !== userId) return refusal(409, ACCOUNT_CHANGED);
    return { body: forwarded, reply: configReply };
  };

  const test = () => ({ reply: testReply });

  app.get(MOUNT, route('GET', '', read));
  app.put(MOUNT, jsonBody(express, { limit: BODY_LIMIT }), route('PUT', '', save));
  app.post(`${MOUNT}/jira/test`, route('POST', '/jira/test', test));
  app.post(`${MOUNT}/plane/test`, route('POST', '/plane/test', test));
}
