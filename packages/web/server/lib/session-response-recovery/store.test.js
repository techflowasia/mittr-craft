import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createResponseRecoveryStore } from './store.js';

const entry = (phase = 'checking', sessionID = 'ses_1') => ({
  owner: 'owner', generation: 1, sessionID, originalHumanMessageID: 'msg_human',
  recoveryID: 'recovery_1', compactID: 'msg_compact', continuationID: 'msg_continue',
  errorEventID: 'evt_failure', errorSeq: 5, failedMessageID: 'msg_failed', phase,
});
const file = async () => path.join(await mkdtemp(path.join(tmpdir(), 'recovery-store-')), 'journal.json');

describe('response recovery journal', () => {
  it('invalidates pending and future writes without releasing the consumed allowance', async () => {
    let release; let entered;
    const held = new Promise(resolve => { release = resolve; });
    const writing = new Promise(resolve => { entered = resolve; });
    const filePath = await file();
    const store = await createResponseRecoveryStore({ filePath, writeFile: async (...args) => { entered(); await held; return writeFile(...args); } });
    const pending = store.put(entry());
    const failed = expect(pending).rejects.toThrow('Recovery journal unavailable');
    await writing;
    store.invalidate();
    expect(store.available()).toBe(false);
    expect(store.get('owner', 'ses_1', 'msg_human')).not.toBeNull();
    release(); await failed; await store.flush();
    expect(store.available()).toBe(false);
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.put(entry('failed'))).rejects.toThrow('Recovery journal unavailable');
  });
  it('persists consumed allowance and serializes independent writes', async () => {
    const filePath = await file();
    const store = await createResponseRecoveryStore({ filePath });
    await Promise.all([store.put(entry()), store.put(entry('failed', 'ses_2'))]);
    const saved = JSON.parse(await readFile(filePath, 'utf8'));
    expect(saved.entries).toHaveLength(2);
    expect(store.get('owner', 'ses_1', 'msg_human').phase).toBe('checking');
    const restarted = await createResponseRecoveryStore({ filePath });
    expect(restarted.get('owner', 'ses_1', 'msg_human').phase).toBe('interrupted');
    expect(restarted.get('owner', 'ses_2', 'msg_human').phase).toBe('failed');
  });
  it.each(['checking', 'compacting', 'continuing', 'awaiting-result'])('interrupts %s on restart without dropping the allowance', async phase => {
    const filePath = await file();
    const store = await createResponseRecoveryStore({ filePath });
    await store.put(entry(phase));
    const restarted = await createResponseRecoveryStore({ filePath });
    expect(restarted.get('owner', 'ses_1', 'msg_human').phase).toBe('interrupted');
  });
  it.each(['{}', '{', '{"version":2,"entries":[]}', '{"version":1,"entries":[{}]}'])('fails closed for invalid journal %s', async body => {
    const filePath = await file(); await writeFile(filePath, body);
    const store = await createResponseRecoveryStore({ filePath });
    expect(store.available()).toBe(false);
    await expect(store.put(entry())).rejects.toThrow();
    expect(await readFile(filePath, 'utf8')).toBe(body);
  });
  it('disables all admission after an uncertain rename and retains the in-memory allowance', async () => {
    const filePath = await file();
    const store = await createResponseRecoveryStore({ filePath, rename: async () => { throw Error('rename failed'); } });
    await expect(store.put(entry())).rejects.toThrow('rename failed');
    expect(store.available()).toBe(false);
    expect(store.get('owner', 'ses_1', 'msg_human')).not.toBeNull();
    await expect(store.put(entry('failed', 'ses_2'))).rejects.toThrow();
  });
  it('does not treat unreadable storage as missing', async () => {
    const store = await createResponseRecoveryStore({ filePath: await file(), readFile: async () => { throw new Error('unreadable'); } });
    expect(store.available()).toBe(false);
    await expect(store.put(entry())).rejects.toThrow();
  });
  it('disables admission on failed temporary write', async () => {
    const store = await createResponseRecoveryStore({ filePath: await file(), writeFile: async () => { throw new Error('write failed'); } });
    await expect(store.put(entry())).rejects.toThrow('write failed');
    expect(store.available()).toBe(false);
  });
  it('retains entries until explicit authoritative deletion', async () => {
    const store = await createResponseRecoveryStore({ filePath: await file() });
    await store.put(entry('failed'));
    await store.deleteSession('other', 'ses_1');
    expect(store.get('owner', 'ses_1', 'msg_human')).not.toBeNull();
    await store.deleteSession('owner', 'ses_1');
    expect(store.get('owner', 'ses_1', 'msg_human')).toBeNull();
  });
});
