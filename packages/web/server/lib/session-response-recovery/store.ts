import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const phases = z.enum(['checking', 'compacting', 'continuing', 'awaiting-result', 'succeeded', 'failed', 'cancelled', 'interrupted']);
const entrySchema = z.object({
  owner: z.string().min(1), generation: z.number().int().nonnegative(),
  sessionID: z.string().min(1), originalHumanMessageID: z.string().min(1),
  recoveryID: z.string().min(1), compactID: z.string().startsWith('msg_').optional(),
  continuationID: z.string().startsWith('msg_'), errorEventID: z.string().min(1),
  errorSeq: z.number().int().nonnegative(), failedMessageID: z.string().min(1),
  phase: phases, reason: z.string().max(160).optional(),
}).strict();
const journalSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema) }).strict();
const terminal = new Set<ResponseRecoveryEntry['phase']>(['succeeded', 'failed', 'cancelled', 'interrupted']);
const key = (owner: string, sessionID: string, humanID: string) => JSON.stringify([owner, sessionID, humanID]);

export type ResponseRecoveryEntry = z.infer<typeof entrySchema>;
export type ResponseRecoveryStore = Awaited<ReturnType<typeof createResponseRecoveryStore>>;
type ResponseRecoveryStoreOptions = {
  filePath: string;
  rename?: (from: string, to: string) => Promise<void>;
  readFile?: (filePath: string, encoding: 'utf8') => Promise<string>;
  writeFile?: (filePath: string, data: string, options: { mode: number }) => Promise<void>;
};

export async function createResponseRecoveryStore({ filePath, rename = fs.rename, readFile = fs.readFile, writeFile = fs.writeFile }: ResponseRecoveryStoreOptions) {
  const entries = new Map<string, ResponseRecoveryEntry>();
  let healthy = true;
  let pending: Promise<void> = Promise.resolve();
  let interrupted = false;
  try {
    const saved = journalSchema.parse(JSON.parse(await readFile(filePath, 'utf8')));
    for (const entry of saved.entries) {
      const id = key(entry.owner, entry.sessionID, entry.originalHumanMessageID);
      if (entries.has(id)) throw new Error('Duplicate recovery allowance');
      if (!terminal.has(entry.phase)) { entry.phase = 'interrupted'; entry.reason = 'server-restarted'; interrupted = true; }
      entries.set(id, entry);
    }
  } catch (error) {
    const failure = z.object({ code: z.string() }).safeParse(error);
    if (!failure.success || failure.data.code !== 'ENOENT') healthy = false;
  }
  const save = () => {
    const task = pending.then(async () => {
      if (!healthy) throw new Error('Recovery journal unavailable');
      const temporary = `${filePath}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(temporary, JSON.stringify({ version: 1, entries: [...entries.values()] }), { mode: 0o600 });
        const file = await fs.open(temporary, 'r');
        try { await file.sync(); } finally { await file.close(); }
        if (!healthy) throw new Error('Recovery journal unavailable');
        await rename(temporary, filePath);
        const directory = await fs.open(path.dirname(filePath), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
        if (!healthy) throw new Error('Recovery journal unavailable');
      } catch (error) {
        healthy = false;
        await fs.unlink(temporary).catch(() => {});
        throw error;
      }
    });
    pending = task.catch(() => {});
    return task;
  };
  if (interrupted && healthy) await save().catch(() => {});
  return {
    available: () => healthy,
    invalidate() { healthy = false; },
    get: (owner: string, sessionID: string, humanID: string) => structuredClone(entries.get(key(owner, sessionID, humanID)) ?? null),
    list: () => structuredClone([...entries.values()]),
    put(entry: ResponseRecoveryEntry) {
      if (!healthy) return Promise.reject(new Error('Recovery journal unavailable'));
      const parsed = entrySchema.parse(entry);
      entries.set(key(parsed.owner, parsed.sessionID, parsed.originalHumanMessageID), parsed);
      return save();
    },
    deleteSession(owner: string, sessionID: string) {
      if (!healthy) return Promise.reject(new Error('Recovery journal unavailable'));
      for (const [id, entry] of entries) if (entry.owner === owner && entry.sessionID === sessionID) entries.delete(id);
      return save();
    },
    flush: () => pending,
  };
}
