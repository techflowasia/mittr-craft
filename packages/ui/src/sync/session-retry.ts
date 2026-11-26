import type { Message, Session, SessionStatus } from '@/lib/opencode/model'
import { getErrorStatus, isAmbiguousSendFailure } from './send-failure-classification'

// 2.0.22 prompt.resume wakes the inbox after admitting a NEW user message.
// There is no public resume/run endpoint. Keep history and request continuation
// explicitly instead. This is not exactly-once tool execution: the model may
// repeat tools despite this instruction.
export const CONTINUATION_PROMPT = 'Continue from where the previous reply stopped. Preserve the work already done and use the existing tool results. Do not restart the original request or repeat completed actions. Check the current state before any action that may already have taken effect.'

export function latestUserTurnID(messages: readonly Message[] | undefined): string | undefined {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index--) {
    if (messages?.[index].role === 'user') return messages[index].id
  }
  return undefined
}

export function canRetryTurn(session: Session, latest: Message | undefined): boolean {
  if (!latest || session.revert) return false
  if (session.outcome === 'failed' || session.outcome === 'interrupted') return true
  // Availability for this case comes from SessionErrorNotice's existing
  // verified unanswered notice. The action still checks a fresh idle snapshot.
  if (latest.role === 'user') return true
  return latest.role === 'assistant' && (!!latest.error || latest.finish === 'length' || latest.finish === 'error')
}

type RetryClient = {
  getSession(id: string, directory: string): Promise<Session>
  getSessionMessages(id: string, options: { limit: number; order: 'desc'; cursor?: string }, directory: string): Promise<{ items: { info: Message }[]; cursor?: { next?: string } }>
  getActiveSessionStatuses(directory: string): Promise<Record<string, SessionStatus> | null>
  listPendingPermissions(options: { directories: string[] }): Promise<{ sessionID: string }[]>
  listPendingForms(options: { directories: string[] }): Promise<{ sessionID: string }[]>
  abortSession(id: string, directory: string): Promise<boolean>
  sendMessage(input: { runtimeKey: string; id: string; directory: string; providerID: string; text: string; onPromptDispatch(): void; beforePromptDispatch(): Promise<void> }): Promise<string>
}

/** One owner for clicks from all mounted chat views, scoped to runtime/directory/session. */
export function createSessionRetry(deps: { runtimeKey(): string; client: RetryClient }) {
  const pending = new Map<string, { turnID: string; run: Promise<void> }>()
  const submitted = new Map<string, string>()
  const continueTurn = async (runtimeKey: string, key: string, id: string, directory: string, turnID: string, confirmInterrupt: () => Promise<boolean>): Promise<void> => {
    const assertRuntime = () => {
      if (deps.runtimeKey() !== runtimeKey) throw new Error('Session runtime changed')
    }
    const readTurn = async () => {
      assertRuntime()
      let cursor: string | undefined
      const seen = new Set<string>()
      do {
        const page = await deps.client.getSessionMessages(id, { limit: 50, order: 'desc', cursor }, directory)
        assertRuntime()
        const user = page.items.find((item) => item.info.role === 'user')
        if (user) {
          if (user.info.id !== turnID) throw new Error('Session turn changed')
          return
        }
        cursor = page.cursor?.next
        if (cursor && seen.has(cursor)) throw new Error('Repeated message cursor')
        if (cursor) seen.add(cursor)
      } while (cursor)
      throw new Error('Session turn changed')
    }
    const read = async () => {
      assertRuntime()
      const [session, page, statuses, permissions, forms] = await Promise.all([
        deps.client.getSession(id, directory),
        deps.client.getSessionMessages(id, { limit: 50, order: 'desc' }, directory),
        deps.client.getActiveSessionStatuses(directory),
        deps.client.listPendingPermissions({ directories: [directory] }),
        deps.client.listPendingForms({ directories: [directory] }),
      ])
      assertRuntime()
      if (statuses === null) throw new Error('Could not verify session activity')
      if (permissions.some((item) => item.sessionID === id) || forms.some((item) => item.sessionID === id)) {
        throw new Error('Session is waiting for input')
      }
      // The descending page includes plumbing records; ignore them, not history.
      const latest = page.items.map((item) => item.info).find((item) => item.role === 'user' || item.role === 'assistant')
      if (!latest || session.directory !== directory || session.revert) throw new Error('Session turn changed')
      // Do this after slower status/form reads, immediately before a mutation.
      await readTurn()
      return { session, latest, busy: statuses[id] !== undefined && statuses[id].type !== 'idle' }
    }
    try {
      let state = await read()
      if (state.busy) {
        if (!await confirmInterrupt()) return
        // Re-read after the dialog: another client may have completed or asked
        // for permission while the user was deciding.
        state = await read()
        if (state.busy) {
          assertRuntime()
          if (!await deps.client.abortSession(id, directory)) throw new Error('Interruption was not confirmed')
          state = await read()
          if (state.busy) throw new Error('Session is still running')
        }
      }
      if (!canRetryTurn(state.session, state.latest)) throw new Error('This turn no longer needs continuation')
      assertRuntime()
      const providerID = state.session.model?.providerID
      if (!providerID) throw new Error('Session model is unavailable')
      // Use the session's authoritative model/agent, not mutable composer picks.
      // Mark before POST: a lost response may still mean the prompt was admitted.
      submitted.delete(key)
      submitted.set(key, turnID)
      if (submitted.size > 100) {
        const oldest = submitted.keys().next()
        if (!oldest.done) submitted.delete(oldest.value)
      }
      let dispatched = false
      try {
        await deps.client.sendMessage({ runtimeKey, id, directory, providerID, text: CONTINUATION_PROMPT,
          beforePromptDispatch: async () => { await readTurn(); assertRuntime() },
          onPromptDispatch: () => { dispatched = true },
        })
      } catch (error) {
        if (!dispatched || (getErrorStatus(error) !== null && !isAmbiguousSendFailure(error))) submitted.delete(key)
        throw error
      }
    } finally {
      pending.delete(key)
    }
  }
  return async (id: string, directory: string, turnID: string, confirmInterrupt: () => Promise<boolean>): Promise<void> => {
    const runtimeKey = deps.runtimeKey()
    const key = JSON.stringify([runtimeKey, directory, id])
    const current = pending.get(key)
    if (current?.turnID === turnID) return current.run
    if (current) throw new Error('Another turn of this session is already continuing')
    if (submitted.get(key) === turnID) throw new Error('This turn was already continued')
    const run = continueTurn(runtimeKey, key, id, directory, turnID, confirmInterrupt)
    pending.set(key, { turnID, run })
    return run
  }
}
