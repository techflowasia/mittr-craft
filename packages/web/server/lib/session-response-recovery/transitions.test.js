import { it, expect } from 'vitest';
import { createRecoveryTransitions } from './transitions.js';

it('settles only its own token, and never resumes across an overlapping account mutation', async () => {
  let resumes = 0; let identity = 'a';
  const transitions = createRecoveryTransitions({ suspend: async () => {}, resume: async () => { resumes++; }, identity: () => identity });
  const a = await transitions.begin();
  const b = await transitions.begin();
  identity = 'b';
  await transitions.end(a); expect(resumes).toBe(0);
  await transitions.end(a); expect(resumes).toBe(0);
  await transitions.ready(); expect(resumes).toBe(0);
  await transitions.end(b); expect(resumes).toBe(1);
});

it('releases no-op and failed account work only after its finally, but not a failed drain', async () => {
  let resumes = 0;
  const transitions = createRecoveryTransitions({ suspend: async () => {}, resume: async () => { resumes++; }, identity: () => 'a' });
  const token = await transitions.begin();
  try { throw new Error('storage failed'); } catch {} finally { await transitions.end(token); }
  expect(resumes).toBe(1);
  const failed = createRecoveryTransitions({ suspend: async () => { throw new Error('uncertain'); }, resume: async () => { resumes++; }, identity: () => 'a' });
  await expect(failed.begin()).rejects.toThrow('uncertain');
  await failed.ready(); expect(resumes).toBe(1);
});
