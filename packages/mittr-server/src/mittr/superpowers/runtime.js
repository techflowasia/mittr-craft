import { z } from 'zod';

const identifier = z.string().trim().min(1).max(1024);
const principalSchema = z.object({ accountID: identifier, runtimeID: identifier, generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
const unavailable = () => ({ status: 'unavailable', httpStatus: 503 });
const disabled = () => ({ status: 'disabled' });
const changed = () => ({ status: 'scope-changed', httpStatus: 409 });
const validPrincipal = (value) => principalSchema.safeParse(value).success && value.accountID !== '_none';

/** Trusted server dependencies only. This module is not an authorization route. */
export function createSuperpowersRuntime({ store, resolveOwner, resolveSession }) {
  const capture = () => {
    const principal = resolveOwner();
    if (!validPrincipal(principal)) return null;
    return { accountID: principal.accountID, runtimeID: principal.runtimeID, generation: principal.generation };
  };
  const current = (scope) => {
    const now = capture();
    return now && now.accountID === scope.accountID && now.runtimeID === scope.runtimeID && now.generation === scope.generation;
  };
  const owner = (scope) => ({ accountID: scope.accountID, runtimeID: scope.runtimeID });
  const run = async (sessionID, operation, needsSession = true) => {
    try {
      const scope = capture();
      if (!scope) return disabled();
      if (needsSession) {
        if (!identifier.safeParse(sessionID).success) return disabled();
        const session = await resolveSession(owner(scope), sessionID);
        if (!current(scope)) return changed();
        // Fail closed for children until verified delegation exists. A fork is
        // a distinct root session, never a copy of a parent's explicit grant.
        if (!session || session.sessionID !== sessionID || session.kind !== 'root') return disabled();
      }
      if (!current(scope)) return changed();
      // Store transactions are synchronous: no async gap between fence and commit.
      const result = operation(owner(scope));
      return current(scope) ? result : changed();
    } catch {
      return unavailable();
    }
  };
  const effectiveGrant = (sessionID) => run(sessionID, (scope) => {
    const result = store.read(scope);
    if (result.status !== 'ok') return result;
    return {
      status: result.document.default === 'on' || result.document.sessions.includes(sessionID) ? 'enabled' : 'disabled',
      revision: result.document.revision,
    };
  });
  const claimOffer = (sessionID, input) => run(sessionID, (scope) => {
    if (!input || Object.keys(input).some((key) => !['turnID', 'expectedRevision'].includes(key))) return { status: 'invalid', httpStatus: 400 };
    return store.claimOffer(scope, { ...input, sessionID });
  });
  const answerOffer = (sessionID, input) => run(sessionID, (scope) => {
    if (!input || Object.keys(input).some((key) => !['offerID', 'decision', 'expectedRevision'].includes(key))) return { status: 'invalid', httpStatus: 400 };
    return store.answerOffer(scope, { ...input, sessionID });
  });
  const setDefault = (input) => run(null, (scope) => store.setDefault(scope, input), false);
  // Called only by an authoritative deletion event, after the session is gone.
  const deleteSession = (sessionID, input) => run(null, (scope) => {
    if (!input || Object.keys(input).some((key) => key !== 'expectedRevision')) return { status: 'invalid', httpStatus: 400 };
    return store.deleteSession(scope, { ...input, sessionID });
  }, false);
  return { effectiveGrant, claimOffer, answerOffer, setDefault, deleteSession };
}
