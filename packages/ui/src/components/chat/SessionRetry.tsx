import React from 'react'
import { useStore } from 'zustand'
import { SessionRetryControl } from './SessionRetryControl'
import { opencodeClient } from '@/lib/opencode/client'
import { getLastConversationMessage } from '@/lib/opencode/model'
import { getRuntimeKey } from '@/lib/runtime-switch'
import { useDirectoryStore, useSessionStatus, useSessionStatusSnapshotReady } from '@/sync/sync-context'
import { canRetryTurn, createSessionRetry, latestUserTurnID } from '@/sync/session-retry'

const retrySession = createSessionRetry({ runtimeKey: getRuntimeKey, client: opencodeClient })

export function SessionRetry({ sessionId, directory, unanswered = false }: { sessionId: string; directory?: string; unanswered?: boolean }) {
  const store = useDirectoryStore(directory)
  const status = useSessionStatus(sessionId, directory)
  const ready = useSessionStatusSnapshotReady(directory, sessionId)
  const session = useStore(store, (state) => state.session.find((item) => item.id === sessionId))
  const messages = useStore(store, (state) => state.message[sessionId])
  const permissions = useStore(store, (state) => state.permission[sessionId])
  const forms = useStore(store, (state) => state.form[sessionId])
  // Part/token updates do not change the message list. Only its structure is
  // relevant to identifying the initiating user turn.
  const userID = React.useMemo(() => latestUserTurnID(messages), [messages])
  const latest = getLastConversationMessage(messages)
  const blocked = (permissions?.length ?? 0) > 0 || (forms?.length ?? 0) > 0
  const idle = status?.type === 'idle' || (status === undefined && ready)
  const eligible = latest?.role === 'user' && session?.outcome !== 'failed' && session?.outcome !== 'interrupted'
    ? unanswered : session && canRetryTurn(session, latest)
  const target = session && latest && userID && !blocked && idle && eligible
    ? JSON.stringify([session.directory, userID]) : null
  if (!target) return null
  return <SessionRetryControl key={JSON.stringify([getRuntimeKey(), sessionId, directory, target])} onRetry={(confirmInterrupt) => {
    const state = store.getState()
    const session = state.session.find((item) => item.id === sessionId)
    const userID = latestUserTurnID(state.message[sessionId])
    if (!session || !userID) return Promise.reject(new Error('Session turn changed'))
    return retrySession(sessionId, session.directory, userID, confirmInterrupt)
  }} />
}

