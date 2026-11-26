import { test, expect } from 'bun:test'
import { opencodeClient } from './client'

test('final retry preflight rejects before the prompt dispatch boundary', async () => {
  let prepared = false
  let dispatched = false
  await expect(opencodeClient.sendMessage({
    id: 'retry-preflight', providerID: 'retry-preflight', text: 'Continue',
    beforePromptDispatch: async () => { prepared = true; throw new Error('newer turn') },
    onPromptDispatch: () => { dispatched = true },
  })).rejects.toThrow('newer turn')
  expect(prepared).toBe(true)
  expect(dispatched).toBe(false)
})
