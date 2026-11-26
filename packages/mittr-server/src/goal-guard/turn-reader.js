const TURN_PAGE_SIZE = 100;
export const TURN_PAGE_LIMIT = 20;
const READ_TIMEOUT_MS = 10_000;

const isRecord = (value) => value instanceof Object && !Array.isArray(value);

const pageOf = (body) => (isRecord(body) && 'data' in body && !('cursor' in body) ? body.data : body);

export const createTurnReader = ({ opencode, fetchImpl = (...args) => fetch(...args) }) => async (sessionId) => {
  const newestFirst = [];
  const cursors = new Set();
  let opener = '';
  let cursor = '';
  for (let page = 0; page < TURN_PAGE_LIMIT; page += 1) {
    const query = new URLSearchParams({ limit: String(TURN_PAGE_SIZE) });
    if (cursor) query.set('cursor', cursor);
    else query.set('order', 'desc');
    const response = await fetchImpl(`${opencode.url(`/api/session/${encodeURIComponent(sessionId)}/message`)}?${query}`, {
      headers: { Accept: 'application/json', ...opencode.authHeaders() },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`message list failed with ${response.status}`);
    const body = pageOf(await response.json());
    if (!isRecord(body) || !Array.isArray(body.data)) throw new Error('message list answered without records');
    const userAt = body.data.findIndex((record) => record?.type === 'user');
    newestFirst.push(...(userAt < 0 ? body.data : body.data.slice(0, userAt)));
    if (userAt >= 0) opener = String(body.data[userAt].text ?? '');
    const next = isRecord(body.cursor) && body.cursor.next ? String(body.cursor.next) : '';
    if (userAt >= 0 || !next || cursors.has(next)) break;
    cursors.add(next);
    cursor = next;
  }
  if (newestFirst.length === 0) return null;
  return { key: String(newestFirst[0].id ?? ''), opener, records: newestFirst.reverse() };
};
