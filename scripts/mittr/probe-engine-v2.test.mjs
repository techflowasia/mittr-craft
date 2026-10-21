import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  agentToolsStopConditions,
  codeModeCall,
  codeModeCatalogHas,
  directToolNames,
  failuresOf,
  headerReport,
  imagePartsOf,
  loopbackPeersFromLsof,
  mcpEntityFromCatalog,
  offeredTools,
  nonLoopbackFromLog,
  nonLoopbackFromLsof,
  openCodeMentions,
  permissionAskedOf,
  permissionPathFor,
  refusedByPolicy,
  shimCallsFor,
  skillsMcpStopConditions,
  stopConditionFor,
  textsOf,
  toolToCall,
  markerHits,
  withoutMarkers,
} from './probe-engine-v2.mjs';
import { MARKER_PNG, MARKER_SHA256 } from './probe-tool-plugin.mjs';
import { STUB_ANSWER, argValue, handleMessage } from './stub-mcp-server.mjs';

test('refusedByPolicy needs an unanswered turn that failed with provider.no-route', () => {
  const noRoute = { type: 'session.execution.failed', error: { type: 'provider.no-route' } };
  assert.equal(refusedByPolicy({ answered: false, events: [{ type: 'session.created' }, noRoute] }), true);
  assert.equal(refusedByPolicy({ answered: false, events: [{ type: 'session.execution.failed', error: { type: 'provider.auth' } }] }), false);
  assert.equal(refusedByPolicy({ answered: true, events: [noRoute] }), false);
});

test('outbound parsers keep only non-loopback peers', () => {
  const lsof = [
    'COMMAND  PID USER FD TYPE DEVICE SIZE/OFF NODE NAME',
    'opencode 1 u 20u IPv4 0x1 0t0 TCP 127.0.0.1:50000 (LISTEN)',
    'opencode 1 u 21u IPv4 0x2 0t0 TCP 127.0.0.1:50001->127.0.0.1:11434 (ESTABLISHED)',
    'opencode 1 u 22u IPv4 0x3 0t0 TCP 192.168.1.5:50002->104.18.2.3:443 (ESTABLISHED)',
    'opencode 1 u 23u IPv6 0x4 0t0 TCP [::1]:50003->[::1]:8080 (ESTABLISHED)',
  ].join('\n');
  assert.deepEqual(nonLoopbackFromLsof(lsof), ['104.18.2.3:443']);
  assert.deepEqual(loopbackPeersFromLsof(lsof), ['50001->11434', '50003->8080']);
  assert.deepEqual(nonLoopbackFromLog('GET http://127.0.0.1:4096/v1 then https://models.dev/api.json and http://localhost:1'), ['models.dev']);
});

test('openCodeMentions counts the name, not paths', () => {
  assert.equal(openCodeMentions('You are an AI agent running in OpenCode. Read .opencode/agents and ~/opencode/x. opencode tools.'), 2);
});

test('stop conditions map to the plan', () => {
  assert.deepEqual(stopConditionFor('P4', { pass: true }), { action: 'none', stop: false });
  assert.equal(stopConditionFor('P4', { pass: false }).stop, true);
  assert.equal(stopConditionFor('P3', { pass: false }).stop, true);
  assert.equal(stopConditionFor('P2', { pass: false, fallbackPass: true }).stop, false);
  assert.equal(stopConditionFor('P2b', { pass: false, fallbackPass: false }).stop, true);
  assert.equal(stopConditionFor('P5', { pass: false }).stop, false);
  assert.equal(stopConditionFor('P6', { pass: false }).stop, false);
  assert.equal(stopConditionFor('P7', { pass: false }).stop, true);
});

test('failuresOf flags missing verdicts and egress', () => {
  const outbound = { nonLoopbackRemotes: [], nonLoopbackHostsInLog: [], proxyNonLoopback: ['models.dev:443'] };
  const failures = failuresOf({ scenarios: { P1: { pass: true } }, outbound });
  assert.ok(failures.includes('P2: no verdict'));
  assert.ok(failures.includes('outbound: proxy models.dev:443'));
  assert.ok(failuresOf({ fatal: 'x', scenarios: {}, outbound }).includes('fatal'));
  assert.deepEqual(failuresOf({ scenarios: { P7: { pass: true } }, outbound: { ...outbound, proxyNonLoopback: [] } }, ['P7']), []);
});

test('shimCallsFor keeps only the shim call lines of one session', () => {
  const lines = [
    { at: 1, line: '[mittr] shim POST /chat/completions 429 session=ses_1' },
    { at: 2, line: '[mittr] shim POST /chat/completions 200 session=ses_10' },
    { at: 3, line: '[mittr] shim cut the answer: Mittr went silent' },
    { at: 4, line: '[mittr] shim POST /chat/completions timeout session=ses_1' },
  ];
  assert.deepEqual(shimCallsFor(lines, 'ses_1'), [
    '[mittr] shim POST /chat/completions 429 session=ses_1',
    '[mittr] shim POST /chat/completions timeout session=ses_1',
  ]);
  assert.deepEqual(shimCallsFor(lines, 'ses_2'), []);
});

test('textsOf collects every text field in order', () => {
  assert.deepEqual(textsOf({ parts: [{ type: 'text', text: 'partial ' }, { type: 'step', nested: { text: 'two' } }], text: 3 }), ['partial ', 'two']);
  assert.deepEqual(textsOf(null), []);
});

test('a local 1.x connector becomes a v2 entry', () => {
  const entry = mcpEntityFromCatalog({ type: 'local', command: ['node', 'x.mjs'], enabled: true });
  assert.equal(entry.type, 'local');
  assert.deepEqual(entry.command, ['node', 'x.mjs']);
  assert.equal(entry.disabled, false);
  assert.equal('enabled' in entry, false);
});

test('a remote connector keeps its url and headers', () => {
  const entry = mcpEntityFromCatalog({ type: 'remote', url: 'https://example.invalid/mcp', headers: { 'x-key': 'v' } });
  assert.equal(entry.type, 'remote');
  assert.equal(entry.url, 'https://example.invalid/mcp');
  assert.deepEqual(entry.headers, { 'x-key': 'v' });
});

test('an entry without a type is refused', () => {
  assert.equal(mcpEntityFromCatalog({ command: ['node', 'x.mjs'], enabled: true }), null);
});

test('offeredTools names every tool in a chat request', () => {
  const body = { tools: [{ type: 'function', function: { name: 'skill' } }, { type: 'function', function: { name: 'mittr-probe_lookup' } }, { name: 'bare' }] };
  assert.deepEqual(offeredTools(body), ['skill', 'mittr-probe_lookup', 'bare']);
  assert.deepEqual(offeredTools({}), []);
  assert.deepEqual(offeredTools(null), []);
});

test('toolToCall picks the wanted tool until a tool result is in the conversation', () => {
  const tools = [{ type: 'function', function: { name: 'read' } }, { type: 'function', function: { name: 'mittr-probe_lookup' } }];
  assert.equal(toolToCall({ tools, messages: [{ role: 'user', content: 'go' }] }, /lookup$/), 'mittr-probe_lookup');
  assert.equal(toolToCall({ tools, messages: [{ role: 'user', content: 'go' }, { role: 'tool', content: 'stub-law-41' }] }, /lookup$/), null);
  assert.equal(toolToCall({ tools: [tools[0]], messages: [{ role: 'user', content: 'go' }] }, /lookup$/), null);
  assert.equal(toolToCall({ tools, messages: [] }, null), null);
});

test('the stub MCP server answers initialize, tools/list and tools/call, and ignores notifications', () => {
  const calls = [];
  const init = handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.deepEqual(handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }).result.tools.map((t) => t.name), ['lookup']);
  const answer = handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lookup', arguments: { query: '41' } } }, { onCall: (p) => calls.push(p) });
  assert.deepEqual(answer.result, STUB_ANSWER);
  assert.deepEqual(answer.result, { content: [{ type: 'text', text: 'stub-law-41' }] });
  assert.equal(calls.length, 1);
  assert.equal(handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'other' } }, { onCall: (p) => calls.push(p) }).error.code, -32602);
  assert.equal(calls.length, 1);
  assert.equal(handleMessage({ jsonrpc: '2.0', id: 5, method: 'resources/list' }).error.code, -32601);
  assert.equal(argValue(['node', 'stub', '--log', '/tmp/x', '--marker', 'm'], '--log'), '/tmp/x');
  assert.equal(argValue(['node', 'stub'], '--log'), null);
});

test('skills-mcp stop conditions follow the brief', () => {
  const pass = { pass: true };
  const all = { P8: { pass: true, nested: true, flat: true }, P9: pass, P10: pass, P10b: pass, P11: { pass: true, perProject: [1, 1, 1] }, P12: pass };
  const none = skillsMcpStopConditions(all);
  assert.ok(Object.values(none).every((c) => c.stop === false && c.action === 'none'));
  assert.equal(skillsMcpStopConditions({ ...all, P8: { pass: false, nested: false, flat: false } }).P8.stop, true);
  assert.match(skillsMcpStopConditions({ ...all, P8: { pass: true, nested: false, flat: true } }).P8.action, /mittr-<name>.*\.mittr-version.*drops the mittr\/ folder/);
  assert.match(skillsMcpStopConditions({ ...all, P9: { pass: false } }).P9.action, /refresh\('mittr catalog skills changed'\)/);
  const fallback = skillsMcpStopConditions({ ...all, P10b: { pass: false } });
  assert.match(fallback.P10b.action, /userConfig/);
  assert.equal(fallback.P10b.stop, false);
  assert.match(skillsMcpStopConditions({ ...all, P10: { pass: false } }).P10.action, /userConfig/);
  const fanOut = skillsMcpStopConditions({ ...all, P11: { pass: false, perProject: [2, 1, 1] } }).P11;
  assert.equal(fanOut.stop, false);
  assert.match(fanOut.action, /owner note/);
  assert.equal(skillsMcpStopConditions({ ...all, P12: { pass: false } }).P12.stop, false);
});

test('codeModeCall runs a catalog tool through execute until a tool result is in the conversation', () => {
  const catalog = '# Code Mode\n- mittr-probe (1 tool)\n  - tools["mittr-probe"].lookup({\n  query?: string,\n}): Promise<unknown>';
  const tools = [{ type: 'function', function: { name: 'execute' } }];
  const body = { tools, messages: [{ role: 'system', content: [{ type: 'text', text: catalog }] }, { role: 'user', content: 'go' }] };
  assert.deepEqual(codeModeCall(body, 'mittr-probe', 'lookup'), { name: 'execute', arguments: { code: 'return await tools["mittr-probe"].lookup({ query: "41" })' } });
  assert.deepEqual(codeModeCall({ ...body, messages: [{ role: 'system', content: catalog }] }, 'mittr-probe', 'lookup')?.name, 'execute');
  assert.equal(codeModeCall({ ...body, messages: [...body.messages, { role: 'tool', content: 'stub-law-41' }] }, 'mittr-probe', 'lookup'), null);
  assert.equal(codeModeCall({ ...body, messages: [{ role: 'system', content: '# Code Mode' }] }, 'mittr-probe', 'lookup'), null);
  assert.equal(codeModeCall({ ...body, tools: [] }, 'mittr-probe', 'lookup'), null);
});

test('failuresOf takes a scenario that went as expected over its pass verdict', () => {
  const outbound = { nonLoopbackRemotes: [], nonLoopbackHostsInLog: [], proxyNonLoopback: [] };
  const run = (P10b) => failuresOf({ scenarios: { P8: { pass: true }, P10b }, outbound }, ['P8', 'P10b']);
  assert.deepEqual(run({ pass: false, asExpected: true }), []);
  assert.deepEqual(run({ pass: true, asExpected: false }), ['P10b: FAIL']);
  assert.deepEqual(run({ pass: false }), ['P10b: FAIL']);
});

test('markerHits says which marker a body holds, and withoutMarkers replaces every one', () => {
  const markers = { header: 'p3-secret-aa', environment: 'p3-env-bb' };
  assert.deepEqual(markerHits('{"headers":{"x":"p3-secret-aa"}}', markers), { header: true, environment: false });
  assert.deepEqual(markerHits('', markers), { header: false, environment: false });
  assert.deepEqual(withoutMarkers({ a: 'p3-secret-aa', b: ['x p3-env-bb y', { c: 'p3-secret-aa' }], markers }, markers), { a: '<marker>', b: ['x <marker> y', { c: '<marker>' }], markers: { header: '<marker>', environment: '<marker>' } });
});

test('headerReport says whether a recorded request carried the marker header, without keeping its value', () => {
  const requests = [
    { method: 'POST', path: '/mcp?codemode=false', headers: { 'content-type': 'application/json', 'x-probe-secret': 'm-1' } },
    { method: 'GET', path: '/mcp?codemode=false', headers: { accept: 'text/event-stream' } },
  ];
  const report = headerReport(requests, 'm-1');
  assert.deepEqual(report, {
    requests: 2,
    paths: ['GET /mcp?codemode=false', 'POST /mcp?codemode=false'],
    headerNames: ['accept', 'content-type', 'x-probe-secret'],
    markerHeaderReceived: true,
    markerAnywhere: true,
  });
  assert.equal(JSON.stringify(report).includes('m-1'), false);
  assert.equal(headerReport([requests[1]], 'm-1').markerAnywhere, false);
  assert.equal(headerReport([{ method: 'POST', path: '/mcp', headers: { 'x-other': 'm-1' } }], 'm-1').markerHeaderReceived, false);
});

test('an image_url data URI is found with its sha256', () => {
  const uri = `data:image/png;base64,${MARKER_PNG}`;
  const body = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: uri } }] },
      { role: 'tool', content: [{ type: 'input_image', image_url: uri }] },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/x.png' } }] },
    ],
  };
  const marker = { mime: 'image/png', bytes: 77, sha256: MARKER_SHA256 };
  assert.deepEqual(imagePartsOf(body), [marker, marker]);
});

test('a tool message with only text has no image', () => {
  const body = { messages: [{ role: 'user', content: 'go' }, { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' }, { role: 'tool', content: [{ type: 'text', text: 'image_url' }] }] };
  assert.deepEqual(imagePartsOf(body), []);
  assert.deepEqual(imagePartsOf(null), []);
});

test('a permission.asked payload gives its action and resources', () => {
  const asked = {
    type: 'permission.asked',
    data: { id: 'per_1', sessionID: 'ses_1', action: 'mittrcraft_chrome', resources: ['probe.example.test'], save: ['probe.example.test'], message: 'Allow?', metadata: { host: 'probe.example.test' }, source: { type: 'tool', messageID: 'msg_1', id: 'call_1' } },
  };
  const events = [{ type: 'session.created', data: { sessionID: 'ses_1' } }, asked, { type: 'permission.replied', data: { sessionID: 'ses_1', requestID: 'per_1', reply: 'once' } }];
  assert.deepEqual(permissionAskedOf(events), [{ id: 'per_1', sessionID: 'ses_1', action: 'mittrcraft_chrome', resources: ['probe.example.test'], save: ['probe.example.test'], message: 'Allow?', metadata: { host: 'probe.example.test' } }]);
  assert.deepEqual(permissionAskedOf([{ type: 'permission.asked', data: { id: 'per_2', sessionID: 'ses_2', action: 'bash', resources: [] } }]), [{ id: 'per_2', sessionID: 'ses_2', action: 'bash', resources: [], save: null, message: null, metadata: null }]);
});

test('a Code Mode catalog line names the tool', () => {
  const system = '# Code Mode\nUse the `execute` tool to call the tools listed below.\n## Available tools\n- mittr_probe_code (1 tool)\n  - tools.mittr_probe_code(input: {}): Promise<unknown> // Probe';
  assert.equal(codeModeCatalogHas(system, 'mittr_probe_code'), true);
  assert.equal(codeModeCatalogHas(system, 'mittr_probe_direct'), false);
  assert.equal(codeModeCatalogHas('The mittr_probe_code tool is described here.', 'mittr_probe_code'), false);
  assert.deepEqual(directToolNames({ tools: [{ type: 'function', function: { name: 'mittr_probe_direct' } }, { type: 'function', function: { name: 'execute' } }] }), ['mittr_probe_direct', 'execute']);
});

test('agent-tools stop conditions follow the brief', () => {
  const cell = (model, call, markerSeen) => ({ model, call, markerSeen });
  const allSeen = [cell('m1', 'direct', true), cell('m1', 'code', true), cell('mimg', 'direct', true), cell('mimg', 'code', true)];
  const base = { P13: { pass: true }, P13b: { pass: true }, P14: { cells: allSeen }, P15: { path: 'E' }, P16: { autoAnswers: true }, P17: { pass: true }, P18: { pass: true } };
  const ok = agentToolsStopConditions(base);
  assert.equal(ok.P13.stop, false);
  assert.equal(ok.P14.action, 'none');
  assert.equal(ok.P15.path, 'E');
  assert.match(ok.P16.action, /needs the A-30 hook/);
  assert.equal(agentToolsStopConditions({ ...base, P13: { pass: false } }).P13.stop, true);
  assert.match(agentToolsStopConditions({ ...base, P13b: { pass: false } }).P13b.action, /hook route/);
  assert.match(agentToolsStopConditions({ ...base, P14: { cells: [cell('m1', 'direct', false), cell('mimg', 'direct', false)] } }).P14.action, /stop the image half/);
  assert.match(agentToolsStopConditions({ ...base, P14: { cells: [cell('m1', 'direct', false), cell('mimg', 'direct', true)] } }).P14.action, /adds input/);
  assert.match(agentToolsStopConditions({ ...base, P14: { cells: [cell('m1', 'direct', true), cell('m1', 'code', false)] } }).P14.action, /Code Mode loses the image/);
  assert.equal(agentToolsStopConditions({ ...base, P14: { cells: [...allSeen, { ...cell('mtext', 'direct', false), diagnostic: true }] } }).P14.action, 'none');
  assert.match(agentToolsStopConditions({ ...base, P16: { autoAnswers: false } }).P16.action, /budget stays 34/);
  assert.match(agentToolsStopConditions({ ...base, P17: { pass: false } }).P17.action, /refresh\('mittr tools changed'\)/);
  assert.match(agentToolsStopConditions({ ...base, P18: { pass: false } }).P18.action, /session\.idle/);
});

test('path E needs a raised ask, all three replies learned, and no answer the engine gives by itself unless its rule can be deleted', () => {
  const learned = { once: true, always: true, reject: true };
  assert.equal(permissionPathFor({ raised: true, learned, engineAnswersLater: false, deletedAndAskedAgain: false }), 'E');
  assert.equal(permissionPathFor({ raised: true, learned, engineAnswersLater: true, deletedAndAskedAgain: true }), 'E');
  assert.equal(permissionPathFor({ raised: true, learned, engineAnswersLater: true, deletedAndAskedAgain: false }), 'M');
  assert.equal(permissionPathFor({ raised: false, learned, engineAnswersLater: false, deletedAndAskedAgain: false }), 'M');
  assert.equal(permissionPathFor({ raised: true, learned: { ...learned, always: false }, engineAnswersLater: false, deletedAndAskedAgain: false }), 'M');
});
