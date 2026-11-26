import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { NextFunction, Request, Response } from '../shared/http-contracts.js';
import { createRecoveryAdmissionGate } from './admission.js';
import { createResponseRecoveryStore } from './store.js';
import { activeSchema, childrenSchema, createSessionResponseRecoveryRuntime } from './runtime.js';
import type { RecoveryArchiveStore, RecoveryChildrenInput, RecoveryClient } from './runtime.js';
import type { JsonValue } from '../shared/json-values.js';

const invalidatingEventSchema = z.object({ type: z.enum(['credential.switched', 'credential.updated', 'location.shutdown']) });

export type ResponseRecoveryOwnerOptions = {
  dataDir: string;
  namespace?: string;
  getNamespace?: () => string;
  account?: () => string;
  client: () => RecoveryClient;
  archiveStore: () => RecoveryArchiveStore;
};
export type ResponseRecoveryOwner = Awaited<ReturnType<typeof createResponseRecoveryOwner>>;

export async function createResponseRecoveryOwner({ dataDir, namespace, getNamespace, account = () => 'default', client, archiveStore }: ResponseRecoveryOwnerOptions) {
  const readNamespace = getNamespace ?? (() => namespace);
  const store = await createResponseRecoveryStore({ filePath: path.join(dataDir, 'response-recovery.json') });
  const identity = () => {
    const accountID = z.string().min(1).parse(account());
    const owner = createHash('sha256').update(JSON.stringify([z.string().min(1).parse(readNamespace()), accountID])).digest('hex');
    return { owner, generation, account: owner };
  };
  let generation = 0;
  let suspended = false;
  const admissions = createRecoveryAdmissionGate({ isReserved: (sessionID: string) => sessionID === '*'
    ? [...observedSessions].some(id => runtime.isReserved(id))
    : runtime.isReserved(sessionID) });
  const runtime = createSessionResponseRecoveryRuntime({
    store, client,
    getIdentity: identity,
    readGuard: async (sessionID, _directory, options, api, upstreamArchived) => {
      await admissions.drain(sessionID);
      const archive = archiveStore();
      const loaded = await archive.load();
      if (loaded.ok !== true || loaded.authoritative !== true) throw new Error('archive-unknown');
      const entries = await archive.getAll();
      const override = entries[sessionID];
      const archived = override === undefined ? Boolean(upstreamArchived) : override !== null;
      const active = activeSchema.parse(await api.session.active(options));
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
        const input: RecoveryChildrenInput = { parentID: sessionID, limit: 100 };
        if (cursor) input.cursor = cursor;
        const page = childrenSchema.parse(await api.session.list(input, options));
        if (page.data.some(child => child.parentID !== sessionID)) throw new Error('children-scope-unknown');
        if (page.data.some(child => active[child.id])) return { known: true, archived, deleted: false, liveChildren: true };
        const next = page.cursor?.next;
        if (!next) return { known: true, archived, deleted: false, liveChildren: false };
        if (cursors.has(next)) throw new Error('children-cursor-loop');
        cursors.add(next); cursor = next;
      }
      throw new Error('children-incomplete');
    },
  });
  let transition: Promise<void> = Promise.resolve();
  let transitionID = 0;
  const observedSessions = new Set<string>();
  const invalidate = async () => {
    generation++;
    await runtime.cancelAll('owner-changed');
    if ([...observedSessions].some(sessionID => runtime.isReserved(sessionID))) throw new Error('response-recovery-admission-uncertain');
  };
  return {
    ...runtime,
    isReserved: (sessionID: string) => runtime.isReserved(sessionID) || admissions.isFenced(sessionID),
    invalidate,
    admissions,
    suspend(): Promise<void> {
      suspended = true; transitionID++;
      const draining = admissions.suspend();
      transition = Promise.all([transition, invalidate(), draining]).then(() => undefined);
      return transition;
    },
    async resume({ recoveryEnabled = true }: { recoveryEnabled?: boolean } = {}): Promise<void> {
      const expected = transitionID;
      await transition;
      if (expected !== transitionID) return;
      admissions.resume(); suspended = !recoveryEnabled;
    },
    async stop(): Promise<void> {
      suspended = true;
      const draining = admissions.suspend();
      const results = await Promise.allSettled([runtime.stop(), draining]);
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    },
    processEvent(event: JsonValue): Promise<void> {
      if (suspended) return Promise.resolve();
      if (invalidatingEventSchema.safeParse(event).success) return invalidate();
      const sessionID = z.object({ data: z.object({ sessionID: z.string() }) }).safeParse(event);
      if (sessionID.success) observedSessions.add(sessionID.data.data.sessionID);
      return runtime.processEvent(event);
    },
    async beforeRequest(req: Request, _res: Response | undefined, next: NextFunction): Promise<void | Response> {
      try {
        const url = new URL(req.originalUrl || req.url, 'http://localhost');
        if (req.method === 'GET' || req.method === 'HEAD') return next();
        if (/^\/api\/(credential|integration)(\/|$)/.test(url.pathname)) await invalidate();
        const match = /^\/api\/(?:openchamber\/sessions|session)\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
        const encodedID = match?.[1];
        if (match && encodedID !== undefined) {
          const action = match[2];
          if (req.method === 'POST' && (action === 'interrupt' || action === 'abort')) {
            void runtime.cancelSession(decodeURIComponent(encodedID), 'stop').catch(() => {});
            return next();
          }
          if (req.method === 'DELETE' || ['prompt', 'message', 'command', 'skill', 'shell', 'interrupt', 'abort', 'compact', 'model', 'agent', 'move', 'revert', 'send', 'archive'].some(name => action === name || action?.startsWith(`${name}/`))) {
            const sessionID = decodeURIComponent(encodedID);
            await runtime.cancelSession(sessionID, 'new-input');
            await admissions.drain(sessionID);
            if (runtime.isReserved(sessionID) || admissions.isFenced(sessionID)) {
              if (_res) return _res.status(409).json({ error: 'Response recovery admission is uncertain; session mutation is blocked.' });
              throw new Error('response-recovery-reserved');
            }
          }
        }
        next();
      } catch {
        if (_res) return _res.status(409).json({ error: 'Session admission could not be drained safely.' });
        next(new Error('response-recovery-reserved'));
      }
    },
  };
}
