import { MITTR_PROVIDER_ID } from './policies.js';

const CONNECT_KEY_ROUTE = `/api/integration/${MITTR_PROVIDER_ID}/connect/key`;
const CREDENTIALS_ROUTE = '/api/credential';
const ENGINE_REQUEST_TIMEOUT_MS = 10_000;
// The engine picks a provider up from its config watcher and rejects a key for
// it with 404 until then; upstream's provider form waits the same way.
const NOT_REGISTERED_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Per managed-engine handle: which engine (by its URL) last took which key.
const lastStored = new WeakMap();

/** Forgets what this engine was given, so the next call stores the key again. */
export const forgetMittrCredential = (opencode) => {
  lastStored.delete(opencode);
};

const isMittrEntry = (entry) => entry?.integrationID === MITTR_PROVIDER_ID;
const isCurrent = (entry, key) => entry.active === true && entry.value?.type === 'key' && entry.value.key === key;

// Each connect adds a credential and activates it, so every engine start
// would leave one more behind ("Mittr 2", "Mittr 3", ...), a dead key after
// each run. The active entry holding this run's key is kept; every other
// Mittr entry goes.
const removeStaleMittrKeys = async ({ opencode, key, fetchImpl }) => {
  const listed = await fetchImpl(opencode.url(CREDENTIALS_ROUTE), {
    headers: opencode.authHeaders(),
    signal: AbortSignal.timeout(ENGINE_REQUEST_TIMEOUT_MS),
  });
  if (!listed.ok) {
    await listed.body?.cancel();
    throw new Error(`The engine did not list its keys (HTTP ${listed.status})`);
  }
  const entries = (await listed.json())?.data;
  if (!Array.isArray(entries)) throw new Error('The engine listed its keys in a shape this version does not know');
  const mittrEntries = entries.filter(isMittrEntry);
  const current = mittrEntries.find((entry) => isCurrent(entry, key));
  if (!current) throw new Error('The engine does not list the Mittr key it just took as active');
  let kept = 0;
  for (const entry of mittrEntries.filter((candidate) => candidate !== current)) {
    const removed = await fetchImpl(opencode.url(`${CREDENTIALS_ROUTE}/${encodeURIComponent(entry.id)}`), {
      method: 'DELETE',
      headers: opencode.authHeaders(),
      signal: AbortSignal.timeout(ENGINE_REQUEST_TIMEOUT_MS),
    });
    await removed.body?.cancel();
    if (!removed.ok) kept += 1;
  }
  if (kept > 0) throw new Error(`The engine kept ${kept} old Mittr key(s)`);
};

/**
 * Hands the engine the shim's per-run key as the Mittr provider's credential,
 * through OpenCode's own integration route, so the engine keeps it in its own
 * credential store, then removes the Mittr keys of earlier runs. `present`
 * when this engine already took this key.
 *
 * Throws when the engine has no port, refuses the key, does not list it as
 * active, or keeps an old one; the next call then tries again. The message
 * never carries a key.
 */
export async function ensureMittrCredential({ opencode, key, fetchImpl = (...args) => fetch(...args), wait = sleep }) {
  const engine = opencode.url('');
  const last = lastStored.get(opencode);
  if (last?.engine === engine && last.key === key) return 'present';

  // The route reads through a location; naming the directory the engine
  // already warmed keeps it from starting another one.
  const headers = { ...opencode.authHeaders(), 'content-type': 'application/json' };
  const directory = opencode.defaultDirectory();
  if (directory) headers['x-opencode-directory'] = encodeURIComponent(directory);
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchImpl(opencode.url(CONNECT_KEY_ROUTE), {
      method: 'POST',
      headers,
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(ENGINE_REQUEST_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (response.ok) break;
    const delay = NOT_REGISTERED_RETRY_DELAYS_MS[attempt];
    if (response.status !== 404 || delay === undefined) {
      throw new Error(`The engine did not take the Mittr key (HTTP ${response.status})`);
    }
    await wait(delay);
  }
  await removeStaleMittrKeys({ opencode, key, fetchImpl });
  lastStored.set(opencode, { engine, key });
  return 'stored';
}
