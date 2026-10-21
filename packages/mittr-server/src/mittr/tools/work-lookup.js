import { callPlatform, platformErrorText } from '../platform.js';
import { pinAccount, sessionKeyOf } from './account-guard.js';
import { MITTR_TOOLS, MittrToolError } from './registry.js';

export const WORK_TOOL_DESCRIPTION = 'jira.get_issue reads one Jira card by key (e.g. MRKB-2122) and plane.get_issue reads one Plane work item by its link or key (e.g. MITRAI-12), both through whatever this account already connected on the Integrations settings page — nothing else to set up. A Plane link is a sign-in page to a plain fetch; read it with plane.get_issue.';

export const WORK_TOOL_PARAMETERS = Object.freeze({
  key: { type: 'string', description: 'Jira issue key (e.g. MRKB-2122), for jira.get_issue' },
  ref: { type: 'string', description: 'Plane work item link or key (e.g. MITRAI-12), for plane.get_issue' },
});

export const MAX_PLANE_LINK_CHARS = 2_048;

const JIRA_ENDPOINT = '/desktop/jira/issues/';
const PLANE_ENDPOINT = '/desktop/plane/issues';
const JIRA_KEY = /^[A-Za-z][A-Za-z0-9_]{1,19}-[0-9]{1,9}$/;
const PLANE_KEY = /^[A-Za-z][A-Za-z0-9]{0,11}-[0-9]{1,9}$/;
const UNSAFE_CHARACTER = /[\s\u0000-\u001f\u007f]/;

const NOT_SIGNED_IN = 'Not signed in to Mittr. Sign in to continue.';
const NO_ISSUE = 'The Mittr platform returned no issue';

const DEFINITIONS = Object.freeze([
  { action: 'jira.get_issue', title: 'Read a Jira card', description: 'Read one Jira issue by key (e.g. MRKB-2122): summary, description, status, priority, assignee', effect: 'read' },
  { action: 'plane.get_issue', title: 'Read a Plane work item', description: 'Read one Plane work item by its link or key (e.g. MITRAI-12): name, description, state, priority, due date', effect: 'read' },
]);

const plainText = (value) => (value === String(value) && value.trim() ? value.trim() : null);

const jiraKeyOf = (input) => {
  const key = plainText(input.key);
  if (!key) throw new MittrToolError('key is required for jira.get_issue', 400);
  if (!JIRA_KEY.test(key)) throw new MittrToolError('key must be a Jira issue key such as MRKB-2122', 400);
  return key.toUpperCase();
};

const isWebLink = (text) => {
  if (text.length > MAX_PLANE_LINK_CHARS || UNSAFE_CHARACTER.test(text)) return false;
  try {
    const link = new URL(text);
    return (link.protocol === 'https:' || link.protocol === 'http:') && link.hostname !== '' && link.username === '' && link.password === '';
  } catch {
    return false;
  }
};

const planeRefOf = (input) => {
  const ref = plainText(input.ref);
  if (!ref) throw new MittrToolError('ref is required for plane.get_issue', 400);
  if (PLANE_KEY.test(ref)) return ref.toUpperCase();
  if (isWebLink(ref)) return ref;
  throw new MittrToolError('ref must be a Plane work item link or key such as MITRAI-12', 400);
};

export function createWorkLookup({
  broker,
  ensureFreshSession,
  engineOnActiveHome,
  activeAccountKey,
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  if (!broker?.baseUrl || ![ensureFreshSession, engineOnActiveHome, activeAccountKey].every((dep) => dep instanceof Function)) return null;
  const urlFor = (route) => new URL(route, broker.baseUrl).toString();

  const read = async (route, failed, { signal } = {}) => {
    const ensureSameAccount = pinAccount({ activeAccountKey, engineOnActiveHome });
    ensureSameAccount();
    const session = await ensureFreshSession();
    if (!session?.accessToken) throw new MittrToolError(NOT_SIGNED_IN, 401);
    ensureSameAccount(sessionKeyOf(session));
    const { response, body, failure } = await callPlatform(fetchImpl, urlFor(route), { accessToken: session.accessToken, signal });
    if (failure) throw new MittrToolError(failure.error, failure.status);
    ensureSameAccount();
    if (!response.ok) throw new MittrToolError(platformErrorText(body) ?? failed, response.status);
    if (body === null || body === undefined) throw new MittrToolError(NO_ISSUE, 502);
    return body;
  };

  return {
    jiraIssue: (input, ctx = {}) => {
      const key = jiraKeyOf(input);
      return read(`${JIRA_ENDPOINT}${encodeURIComponent(key)}`, `Failed to load Jira issue ${key}`, ctx);
    },
    planeIssue: (input, ctx = {}) => {
      const ref = planeRefOf(input);
      return read(`${PLANE_ENDPOINT}?ref=${encodeURIComponent(ref)}`, `Failed to load Plane work item ${ref}`, ctx);
    },
  };
}

export function registerWorkActions(registry, deps = {}) {
  registry.defineTool({ name: MITTR_TOOLS.work, description: WORK_TOOL_DESCRIPTION, parameters: WORK_TOOL_PARAMETERS });
  const lookup = createWorkLookup(deps);
  const runs = {
    'jira.get_issue': (input, ctx) => lookup.jiraIssue(input, ctx),
    'plane.get_issue': (input, ctx) => lookup.planeIssue(input, ctx),
  };
  for (const definition of DEFINITIONS) {
    registry.register({
      ...definition,
      tool: MITTR_TOOLS.work,
      available: () => lookup !== null,
      execute: (input, ctx) => runs[definition.action](input, ctx),
    });
  }
}
