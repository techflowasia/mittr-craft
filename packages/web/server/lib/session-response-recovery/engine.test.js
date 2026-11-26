import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { createOpenCodeClient } from '../openchamber-sessions/opencode-client.js';
import { createResponseRecoveryOwner } from './owner.js';

// Opt in with a V2 binary. Never connect this test to the running app or a real provider.
const binary = process.env.RESPONSE_RECOVERY_TEST_ENGINE;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async predicate => {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error('Controlled engine did not reach the expected state');
};

it.skipIf(!binary).each(['failed', 'succeeded', 'cancelled'])('limits actual V2 recovery to one continuation for provider outcome %s', async outcome => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'response-recovery-engine-'));
  const project = path.join(root, 'project');
  const config = path.join(root, 'config', 'opencode');
  let providerRequests = 0;
  const provider = http.createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; }
    providerRequests++;
    if (outcome === 'succeeded' && providerRequests > 2) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'local-proof', object: 'chat.completion.chunk', created: 1, model: 'proof', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      res.end(chunk({ role: 'assistant', content: 'OK' }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
      return;
    }
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'response_length_limit', message: 'Controlled length failure', type: 'invalid_request_error' } }));
  });
  let engine;
  let owner;
  let eventWork;
  const events = new AbortController();
  try {
    await mkdir(project, { recursive: true });
    await mkdir(config, { recursive: true });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const address = z.object({ port: z.number().int().positive() }).parse(provider.address());
    await writeFile(path.join(config, 'opencode.json'), JSON.stringify({
      model: 'proof/proof', snapshots: false, update: 'disable',
      providers: { proof: { name: 'Local proof', package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test-only' },
        models: { proof: { name: 'Proof', limit: { context: 32000, output: 1024 } } } } },
    }));
    engine = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
      cwd: project,
      env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'),
        XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'),
        XDG_STATE_HOME: path.join(root, 'state'), OPENCODE_CONFIG_DIR: config, OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Startup output contains the ephemeral password: retain it only in memory.
    let output = '';
    let launchError;
    engine.on('error', error => { launchError = error; });
    engine.stdout.on('data', chunk => { output += chunk; });
    engine.stderr.on('data', chunk => { output += chunk; });
    await until(() => {
      if (launchError || engine.exitCode !== null) throw new Error('Isolated V2 engine failed to start');
      return /https?:\/\/127\.0\.0\.1:\d+/.test(output) && /server password \S+/.test(output);
    });
    const endpoint = output.match(/https?:\/\/127\.0\.0\.1:\d+/)?.[0];
    const password = output.match(/server password (\S+)/)?.[1];
    if (!endpoint || !password) throw new Error('Isolated engine startup contract changed');
    const rawTrace = [];
    const api = createOpenCodeClient({ baseUrl: endpoint, directory: project,
      fetchImpl: async (...args) => {
        const response = await fetch(...args);
        if (new URL(args[0] instanceof Request ? args[0].url : args[0]).pathname === '/api/event') {
          void (async () => {
            let buffer = '';
            const reader = response.clone().body.getReader();
            const decoder = new TextDecoder();
            try {
              while (true) {
                const chunk = await reader.read(); if (chunk.done) break;
                buffer += decoder.decode(chunk.value, { stream: true });
                const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
                for (const line of lines) if (line.startsWith('data:')) {
                  const event = JSON.parse(line.slice(5));
                  rawTrace.push({ type: event.type, seq: event.durable?.seq });
                }
              }
            } catch { /* Isolated stream closes when the test aborts. */ }
          })();
        }
        return response;
      },
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } });
    const session = await api.session.create({ agent: 'build', model: { providerID: 'proof', id: 'proof' } });
    owner = await createResponseRecoveryOwner({ dataDir: path.join(root, 'recovery'), namespace: 'isolated-engine',
      account: () => 'proof', client: () => api,
      archiveStore: () => ({ load: async () => ({ ok: true, authoritative: true }), getAll: async () => ({}) }) });
    const failures = [];
    const trace = [];
    let cancellation;
    eventWork = (async () => {
      try {
        for await (const event of api.event.subscribe({ signal: events.signal })) {
          trace.push({ type: event.type, seq: event.durable?.seq });
          if (event.type === 'session.execution.failed') failures.push(event);
          // Awaiting recovery here would block the events required to settle it.
          void owner.processEvent(event);
          if (outcome === 'cancelled' && event.type === 'session.execution.failed') cancellation = owner.cancelSession(session.id, 'stop');
        }
      } catch (error) { if (!events.signal.aborted) throw error; }
    })();
    await delay(200);
    await api.session.prompt({ sessionID: session.id, text: 'Reply with OK only.' });
    try {
      await until(() => {
        const phase = owner.snapshot(session.id)?.phase;
        return (phase === outcome || (outcome === 'succeeded' && phase === 'failed')) && !owner.isReserved(session.id);
      });
    } catch {
      throw new Error(JSON.stringify({ outcome, providerRequests, recovery: owner.snapshot(session.id), trace }));
    }
    await cancellation;
    if (outcome === 'succeeded') {
      await until(() => trace.some(event => event.type === 'session.execution.succeeded'));
      if (owner.snapshot(session.id)?.phase === 'failed') {
        // V2.0.22 can omit a durable sequence from this stream. Refusal is
        // acceptable only with evidence of that ambiguity, not any failure.
        const sequences = trace.flatMap(event => event.seq === undefined ? [] : [event.seq]);
        expect(sequences.some((seq, index) => index > 0 && seq > sequences[index - 1] + 1)).toBe(true);
        await until(() => rawTrace.some(event => event.type === 'session.execution.succeeded'));
        // Compare raw wire sequence projection, before the SDK can filter events.
        const wireSequences = rawTrace.flatMap(event => event.seq === undefined ? [] : [event.seq]);
        expect(wireSequences).toEqual(sequences);
        expect(wireSequences.some((seq, index) => index > 0 && seq > wireSequences[index - 1] + 1)).toBe(true);
      } else {
        expect(owner.snapshot(session.id)?.phase).toBe('succeeded');
      }
    }
    const records = await api.message.list({ sessionID: session.id, order: 'desc', limit: 100 });
    expect(records.data.filter(message => message.type === 'user')).toHaveLength(outcome === 'cancelled' ? 1 : 2);
    expect(records.data.filter(message => message.type === 'assistant' && message.error)).toHaveLength(outcome === 'failed' ? 2 : 1);
    expect(failures).toHaveLength(outcome === 'failed' ? 2 : 1);
    expect(records.data.filter(message => message.type === 'compaction')).toHaveLength(0);
    expect(providerRequests).toBeGreaterThanOrEqual(2);
    for (const failure of failures) await owner.processEvent(failure);
    await delay(500);
    const afterReplay = await api.message.list({ sessionID: session.id, order: 'desc', limit: 100 });
    expect(afterReplay.data.filter(message => message.type === 'user')).toHaveLength(outcome === 'cancelled' ? 1 : 2);

    const children = [await api.session.create({ parentID: session.id }), await api.session.create({ parentID: session.id })];
    await api.session.create({});
    const first = await api.session.list({ parentID: session.id, limit: 1 });
    const second = await api.session.list({ parentID: session.id, limit: 1, cursor: first.cursor.next });
    expect(first.data).toHaveLength(1);
    expect(second.data).toHaveLength(1);
    const paged = [...first.data, ...second.data];
    expect(paged.map(child => child.id).sort()).toEqual(children.map(child => child.id).sort());
    expect(paged.every(child => child.parentID === session.id)).toBe(true);
  } finally {
    events.abort();
    await owner?.stop();
    await eventWork;
    if (engine && engine.exitCode === null) {
      const exited = once(engine, 'exit');
      engine.kill('SIGTERM');
      await Promise.race([exited, delay(5000)]);
      if (engine.exitCode === null) { engine.kill('SIGKILL'); await exited; }
    }
    provider.closeAllConnections();
    if (provider.listening) await new Promise(resolve => provider.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
