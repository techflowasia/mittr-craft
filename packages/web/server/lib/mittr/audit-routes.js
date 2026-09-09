import { createAuditRecord } from './audit-record.js';
import { serializeAuditRecord } from './audit-serializer.js';

// No `/api` prefix: that path belongs to Better Auth's middleware on the
// platform side and 404s. See auth-routes.js.
const AUDIT_ENDPOINT = '/desktop/audit';

// A session that is never finished would otherwise accumulate for as long as
// the server runs. Dropping the oldest open record is the lesser harm: audit is
// there to understand usage, not to gate access, and it must never be the
// reason a long-lived server runs out of memory.
const MAX_OPEN_RECORDS = 200;

export function registerMittrAuditRoutes(app, {
  brokerBaseUrl,
  ensureFreshSession,
  resolveRepository,
  fetchImpl = fetch,
}) {
  const open = new Map();

  const recordFor = (sessionId) => {
    if (!open.has(sessionId)) {
      if (open.size >= MAX_OPEN_RECORDS) open.delete(open.keys().next().value);
      open.set(sessionId, createAuditRecord({}));
    }
    return open.get(sessionId);
  };

  app.post('/api/mittr/audit/prompt', (req, res) => {
    const text = String(req.body?.text ?? '');
    if (text) recordFor(String(req.body?.sessionId ?? '')).addPrompt(text);
    return res.status(204).end();
  });

  app.post('/api/mittr/audit/tool', (req, res) => {
    const name = String(req.body?.name ?? '');
    // The name only. Arguments are never read off this request.
    if (name) recordFor(String(req.body?.sessionId ?? '')).addToolUse(name);
    return res.status(204).end();
  });

  app.post('/api/mittr/audit/turn', (req, res) => {
    const tokens = Number(req.body?.tokens);
    recordFor(String(req.body?.sessionId ?? '')).addTurn({
      tokens: Number.isFinite(tokens) ? tokens : 0,
    });
    return res.status(204).end();
  });

  app.post('/api/mittr/audit/finish', async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? '');
    const record = recordFor(sessionId);
    open.delete(sessionId);

    record.setRepository(await resolveRepository(String(req.body?.directory ?? '')));
    // The model alias is opaque and Mittr minted it, so it is carried through
    // rather than interpreted here.
    if (req.body?.model) record.setModel(String(req.body.model));
    const payload = serializeAuditRecord(record.finish(String(req.body?.outcome ?? 'unknown')));

    // Identity is the broker's to determine from the session it verified. Any
    // user identifier on this request is ignored (spec §11.2).
    const session = await ensureFreshSession();
    if (!session?.accessToken) return res.status(204).end();

    try {
      await fetchImpl(new URL(AUDIT_ENDPOINT, brokerBaseUrl).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      // Never block work on the audit trail. It exists to understand usage, not
      // to gate access (spec §9).
      console.warn('[mittr] audit record was not delivered:', error?.message ?? error);
    }

    return res.status(204).end();
  });
}
