import { afterAll, describe, expect, test } from 'bun:test'

import { checkConnectedServerForUpdates } from './useUpdateStore'

const realFetch = globalThis.fetch
// What /api/openchamber/update-check returns, including a malformed flag.
type ServerAnswer = { available: boolean; currentVersion: string; updatesDisabled?: boolean | string; packageManager?: string }

let answer: ServerAnswer = { available: false, currentVersion: '0.0.0' }
globalThis.fetch = async () => new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } })

afterAll(() => {
  globalThis.fetch = realFetch
})

describe('update check answers read from the server', () => {
  test('keep the flag a server sends when its build has no update channel', async () => {
    answer = { available: false, updatesDisabled: true, currentVersion: '2.1.1', packageManager: 'electron' }
    const info = await checkConnectedServerForUpdates()
    expect(info.available).toBe(false)
    expect(info.currentVersion).toBe('2.1.1')
    expect('updatesDisabled' in info && info.updatesDisabled).toBe(true)
  })

  test('add nothing when the server has an update channel', async () => {
    answer = { available: false, currentVersion: '2.1.1', updatesDisabled: 'yes' }
    const info = await checkConnectedServerForUpdates()
    expect('updatesDisabled' in info).toBe(false)
  })
})
