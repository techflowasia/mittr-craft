import assert from 'node:assert/strict';
import test from 'node:test';

import { TURN_PAGE_LIMIT, createTurnReader } from './turn-reader.js';

const SESSION = 'ses_1';

const pagedOpenCode = (newestFirst, { pageSize = 2, envelope = true } = {}) => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    requests.push({ path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), headers: init.headers });
    const start = parsed.searchParams.has('cursor') ? Number(parsed.searchParams.get('cursor')) : 0;
    const data = newestFirst.slice(start, start + pageSize);
    const page = { data, cursor: start + pageSize < newestFirst.length ? { next: String(start + pageSize) } : {} };
    return Response.json(envelope ? { location: { directory: '/repo' }, data: page } : page);
  };
  const opencode = { url: (route) => `http://opencode.test${route}`, authHeaders: () => ({ authorization: 'Bearer local' }) };
  return { requests, readTurn: createTurnReader({ opencode, fetchImpl }) };
};

const assistant = (id) => ({ id, type: 'assistant', content: [] });

test('reads back to the newest user message and returns the turn oldest first', async () => {
  const { requests, readTurn } = pagedOpenCode([
    assistant('msg_5'),
    { id: 'msg_4', type: 'compaction' },
    assistant('msg_3'),
    { id: 'msg_2', type: 'user', text: 'The session goal is still open.' },
    assistant('msg_1'),
  ]);

  const turn = await readTurn(SESSION);

  assert.equal(turn.key, 'msg_5');
  assert.equal(turn.opener, 'The session goal is still open.');
  assert.deepEqual(turn.records.map((record) => record.id), ['msg_3', 'msg_4', 'msg_5']);
  assert.deepEqual(requests.map((request) => request.query), [
    { limit: '100', order: 'desc' },
    { limit: '100', cursor: '2' },
  ]);
  assert.equal(requests[0].path, `/api/session/${SESSION}/message`);
  assert.equal(requests[0].headers.authorization, 'Bearer local');
});

test('reads an unwrapped page the same way', async () => {
  const { readTurn } = pagedOpenCode([assistant('msg_2'), { id: 'msg_1', type: 'user' }], { envelope: false });

  assert.deepEqual((await readTurn(SESSION)).records.map((record) => record.id), ['msg_2']);
});

test('stops after the page limit and judges what it read', async () => {
  const records = Array.from({ length: TURN_PAGE_LIMIT * 2 + 10 }, (_, index) => assistant(`msg_${index}`));
  const { requests, readTurn } = pagedOpenCode(records);

  const turn = await readTurn(SESSION);

  assert.equal(requests.length, TURN_PAGE_LIMIT);
  assert.equal(turn.opener, '');
  assert.equal(turn.records.length, TURN_PAGE_LIMIT * 2);
});

test('has no turn when the session has no reply after the newest user message', async () => {
  const { readTurn } = pagedOpenCode([{ id: 'msg_1', type: 'user' }]);

  assert.equal(await readTurn(SESSION), null);
});

test('a failed read is an error, not an empty turn', async () => {
  const opencode = { url: (route) => `http://opencode.test${route}`, authHeaders: () => ({}) };
  const readTurn = createTurnReader({ opencode, fetchImpl: async () => new Response('nope', { status: 500 }) });

  await assert.rejects(readTurn(SESSION), /500/);
});
