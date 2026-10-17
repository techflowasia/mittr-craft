import { createAuditRecord } from './audit-record.js';
import { serializeAuditRecord } from './audit-serializer.js';
import { resolveRepositoryIdentity } from './repository-identity.js';

const AUDIT_ENDPOINT = '/desktop/audit';
const MAX_OPEN_RECORDS = 200;
const PLATFORM_TIMEOUT_MS = 15_000;
const REMOTE_LOOKUP_TIMEOUT_MS = 5_000;
const MAX_CLEARED_SESSIONS = 1000;

export function registerMittrAuditRoutes(app, {
  express,
  broker,
  ensureFreshSession,
  activeUserId,
  git,
  fetchImpl = (...args) => fetch(...args),
  logger = console,
  remoteTimeoutMs = REMOTE_LOOKUP_TIMEOUT_MS,
}) {
  const open = new Map();
  const cleared = new Set();
  let epoch = 0;

  const currentUser = () => {
    try {
      return activeUserId() ?? null;
    } catch {
      return null;
    }
  };

  const remoteUrl = (directory) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), remoteTimeoutMs);
    Promise.resolve().then(() => git.remoteUrl(directory)).then(resolve, reject).finally(() => clearTimeout(timer));
  });

  const readJson = (limit) => {
    const parse = express.json({ limit });
    return (req, res, next) => parse(req, res, (error) => {
      if (!error) return next();
      return res.status(error.status ?? 400).json({ error: 'Invalid request body' });
    });
  };

  const recordFor = (sessionId) => {
    if (open.has(sessionId)) return open.get(sessionId).record;
    if (cleared.has(sessionId)) return null;
    const owner = currentUser();
    if (owner === null) return null;
    if (open.size >= MAX_OPEN_RECORDS) open.delete(open.keys().next().value);
    const entry = { record: createAuditRecord({}), owner };
    open.set(sessionId, entry);
    return entry.record;
  };

  app.post('/api/mittr/audit/prompt', readJson('256kb'), (req, res) => {
    const text = String(req.body?.text ?? '');
    if (text) recordFor(String(req.body?.sessionId ?? ''))?.addPrompt(text);
    return res.status(204).end();
  });

  app.post('/api/mittr/audit/tool', readJson('8kb'), (req, res) => {
    const name = String(req.body?.name ?? '');
    if (name) recordFor(String(req.body?.sessionId ?? ''))?.addToolUse(name);
    return res.status(204).end();
  });

  app.post('/api/mittr/audit/turn', readJson('8kb'), (req, res) => {
    const tokens = Number(req.body?.tokens);
    recordFor(String(req.body?.sessionId ?? ''))?.addTurn({ tokens: Number.isFinite(tokens) ? tokens : 0 });
    return res.status(204).end();
  });

  app.post('/api/mittr/audit/finish', readJson('8kb'), async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? '');
    const startedIn = epoch;
    const entry = open.get(sessionId);
    open.delete(sessionId);
    if (!entry || currentUser() !== entry.owner) return res.status(204).end();
    const { record, owner } = entry;

    try {
      record.setRepository(await resolveRepositoryIdentity(String(req.body?.directory ?? ''), {
        remoteUrl,
      }));
      if (req.body?.model) record.setModel(String(req.body.model));
      const payload = serializeAuditRecord(record.finish(String(req.body?.outcome ?? 'unknown')));

      const session = await ensureFreshSession();
      if (!session?.accessToken || session.subject?.userId !== owner || startedIn !== epoch) return res.status(204).end();

      const response = await fetchImpl(new URL(AUDIT_ENDPOINT, broker.baseUrl).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
      });
      if (!response.ok) logger.warn(`[mittr] audit record was not accepted: ${response.status}`);
    } catch (error) {
      logger.warn('[mittr] audit record was not delivered:', error?.message ?? error);
    }

    return res.status(204).end();
  });

  return {
    clear: () => {
      epoch += 1;
      for (const sessionId of open.keys()) {
        cleared.delete(sessionId);
        cleared.add(sessionId);
        if (cleared.size > MAX_CLEARED_SESSIONS) cleared.delete(cleared.values().next().value);
      }
      open.clear();
    },
  };
}
