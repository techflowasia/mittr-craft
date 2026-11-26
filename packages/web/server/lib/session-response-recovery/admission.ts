import { AsyncLocalStorage } from 'node:async_hooks';

export type FetchInit = RequestInit | (Omit<RequestInit, 'body'> & { body?: BodyInit | null | undefined });
export type FetchLike = (input: string | URL | Request, init?: FetchInit) => Promise<Response>;

const toRequestInit = (init?: FetchInit): RequestInit | undefined => {
  if (!init) return undefined;
  const { body, ...rest } = init;
  return body === undefined ? rest : { ...rest, body };
};
export type RecoveryAdmissionTicket = { finish: (definitive: boolean) => void; signal: AbortSignal };
export type RecoveryAdmissionGate = ReturnType<typeof createRecoveryAdmissionGate>;

export function createRecoveryAdmissionGate({ isReserved }: { isReserved: (sessionID: string) => boolean }) {
  const scope = new AsyncLocalStorage<number>();
  const pending = new Map<string, Set<Promise<void>>>();
  const fenced = new Set<string>();
  let generation = 0;
  let suspended = false;
  const isFenced = (sessionID: string) => fenced.has(sessionID) || fenced.has('*');
  const assertClear = (sessionID?: string) => {
    if (sessionID ? isFenced(sessionID) : fenced.size) throw new Error('admission-uncertain');
  };
  const drain = async (sessionID?: string): Promise<void> => {
    const work = sessionID ? [...(pending.get(sessionID) ?? []), ...(pending.get('*') ?? [])] : [...pending.values()].flatMap(entries => [...entries]);
    await Promise.all(work);
    assertClear(sessionID);
  };
  const begin = (sessionID: string, expected: number = scope.getStore() ?? generation): RecoveryAdmissionTicket => {
    if (suspended || expected !== generation) throw new Error('upstream-transition');
    assertClear(sessionID);
    if (isReserved(sessionID)) throw new Error('response-recovery-reserved');
    let release = () => {};
    const settled = new Promise<void>(resolve => { release = resolve; });
    const entries = pending.get(sessionID) ?? new Set<Promise<void>>();
    entries.add(settled); pending.set(sessionID, entries);
    const abort = new AbortController();
    let finished = false;
    const finish = (definitive: boolean) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (!definitive) { fenced.add(sessionID); abort.abort(); }
      entries.delete(settled);
      if (!entries.size) pending.delete(sessionID);
      release();
    };
    const timer = setTimeout(() => finish(false), 120_000);
    timer.unref?.();
    return { finish, signal: abort.signal };
  };
  return {
    drain, begin, isFenced,
    run<T>(task: () => T): T { return scope.run(scope.getStore() ?? generation, task); },
    suspend(): Promise<void> { suspended = true; generation++; return drain(); },
    resume(): void { assertClear(); if (pending.size) throw new Error('upstream-drain-pending'); suspended = false; },
    fetch(fetchImpl: FetchLike, { capture = false }: { capture?: boolean } = {}): FetchLike {
      const captured = generation;
      return async (input, init) => {
        const requestInit = toRequestInit(init);
        const request = new Request(input, requestInit);
        if (request.method === 'GET' || request.method === 'HEAD') return fetchImpl(input, init);
        const match = /^\/api\/session\/([^/]+)(?:\/|$)/.exec(new URL(request.url).pathname);
        const encodedID = match?.[1];
        const ticket = begin(encodedID !== undefined ? decodeURIComponent(encodedID) : '*', capture ? captured : (scope.getStore() ?? generation));
        try {
          const response = await fetchImpl(input, { ...requestInit, signal: AbortSignal.any([request.signal, ticket.signal]) });
          await response.clone().arrayBuffer();
          ticket.finish(response.status < 500 && response.status !== 408);
          return response;
        } catch (error) { ticket.finish(false); throw error; }
      };
    },
  };
}
