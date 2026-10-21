import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { toMcpEntity } from '../../../web/server/lib/opencode/config-v2.js';
import { catalogMcpEntity, heldMcpNames, mcpFragment, mcpServerName, sweepLegacyUserMcp } from './mcp-fragment.js';

const recording = () => {
  const calls = [];
  const toEntity = (raw) => {
    calls.push(raw);
    return { converted: true, ...raw };
  };
  return { calls, toEntity };
};

test('a local entry with a command goes to the converter', () => {
  const { calls, toEntity } = recording();
  const raw = { type: 'local', command: ['node', 'x.mjs'], enabled: true };
  assert.deepEqual(catalogMcpEntity(raw, toEntity), { converted: true, ...raw });
  assert.deepEqual(calls, [raw]);
});

test('a remote entry with a url goes to the converter', () => {
  const { calls, toEntity } = recording();
  const raw = { type: 'remote', url: 'https://example.invalid/mcp', headers: { a: 'b' } };
  assert.deepEqual(catalogMcpEntity(raw, toEntity), { converted: true, ...raw });
  assert.equal(calls.length, 1);
});

test('an entry without a type is refused before the converter', () => {
  const { calls, toEntity } = recording();
  assert.equal(catalogMcpEntity({ command: ['node', 'x.mjs'] }, toEntity), null);
  assert.equal(catalogMcpEntity({ enabled: true }, toEntity), null);
  assert.deepEqual(calls, []);
});

test('a local entry without a command is refused', () => {
  const { calls, toEntity } = recording();
  for (const command of [undefined, [], 'node x.mjs', null]) {
    assert.equal(catalogMcpEntity({ type: 'local', command }, toEntity), null, String(command));
  }
  assert.deepEqual(calls, []);
});

test('a local command with an item that is not a non-empty string is refused', () => {
  const { calls, toEntity } = recording();
  assert.equal(catalogMcpEntity({ type: 'local', command: [1, null] }, toEntity), null);
  assert.equal(catalogMcpEntity({ type: 'local', command: [''] }, toEntity), null);
  assert.equal(catalogMcpEntity({ type: 'local', command: ['node', ''] }, toEntity), null);
  assert.deepEqual(calls, []);
});

test('a remote entry without a url is refused', () => {
  const { calls, toEntity } = recording();
  for (const url of [undefined, '', '   ', 42]) {
    assert.equal(catalogMcpEntity({ type: 'remote', url }, toEntity), null, String(url));
  }
  assert.deepEqual(calls, []);
});

test('an unknown type or a value that is not an object is refused', () => {
  const { calls, toEntity } = recording();
  for (const raw of [{ type: 'sse', url: 'https://example.invalid' }, null, undefined, 'local', ['local']]) {
    assert.equal(catalogMcpEntity(raw, toEntity), null, JSON.stringify(raw));
  }
  assert.deepEqual(calls, []);
});

const recordingLogger = () => {
  const warnings = [];
  return { warnings, warn: (...args) => warnings.push(args.join(' ')), log: () => {} };
};
const enabledAll = { isEnabled: () => true };
const disabling = (...names) => ({ isEnabled: (kind, name) => !(kind === 'mcp' && names.includes(name)) });
const connector = (name, config) => ({ name, config });
const local = (...command) => ({ type: 'local', command });
const UPSTREAM_NAME_RULE = /^[a-z0-9][a-z0-9_-]*[a-z0-9]$/;

test('a catalog name becomes a mittr- server name the engine accepts', () => {
  assert.equal(mcpServerName('iApp Thai Legal'), 'mittr-iapp-thai-legal');
  assert.equal(mcpServerName('docs'), 'mittr-docs');
  assert.equal(mcpServerName('  Law/Search!  '), 'mittr-law-search');
  assert.equal(mcpServerName('a_b'), 'mittr-a_b');
  assert.equal(mcpServerName('_x_'), 'mittr-x');
  for (const name of ['', '   ', null, undefined, 42]) assert.equal(mcpServerName(name), null, String(name));
  for (const name of ['A', 'z-', '-9', 'x__', 'ไทย1', 'Ünïcode', 'a/b', 'mittr', '1', 'tab\tname', 'กฎหมายไทย', '---', '___']) {
    assert.match(mcpServerName(name), UPSTREAM_NAME_RULE, name);
  }
});

test('a name with nothing left after sanitising gets a stable hashed name', () => {
  const hashed = (name) => `mittr-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
  assert.equal(mcpServerName('กฎหมายไทย'), hashed('กฎหมายไทย'));
  assert.equal(mcpServerName('กฎหมายไทย'), mcpServerName('กฎหมายไทย'));
  assert.notEqual(mcpServerName('กฎหมายไทย'), mcpServerName('ภาษีไทย'));
  assert.equal(mcpServerName('---'), hashed('---'));
  const collection = { configured: true, items: [connector('กฎหมายไทย', local('thai-law-mcp'))] };
  assert.deepEqual(mcpFragment({ collection, enablement: enabledAll, toEntity: toMcpEntity, logger: recordingLogger() }), {
    mcp: { servers: { [hashed('กฎหมายไทย')]: { type: 'local', command: ['thai-law-mcp'] } } },
  });
});

test('renders enabled connectors under mittr- names', () => {
  const collection = { configured: true, items: [connector('iApp Thai Legal', local('npx', '-y', 'acme-legal')), connector('docs', { type: 'remote', url: 'https://acme.example/mcp', enabled: false })] };
  assert.deepEqual(mcpFragment({ collection, enablement: enabledAll, toEntity: toMcpEntity, logger: recordingLogger() }), {
    mcp: {
      servers: {
        'mittr-iapp-thai-legal': { type: 'local', command: ['npx', '-y', 'acme-legal'] },
        'mittr-docs': { type: 'remote', url: 'https://acme.example/mcp', disabled: true },
      },
    },
  });
});

test('a disabled connector is left out', () => {
  const logger = recordingLogger();
  const collection = { configured: true, items: [connector('docs', local('docs-mcp')), connector('law', local('law-mcp'))] };
  assert.deepEqual(Object.keys(mcpFragment({ collection, enablement: disabling('docs'), toEntity: toMcpEntity, logger }).mcp.servers), ['mittr-law']);
  assert.deepEqual(logger.warnings, []);
});

test('two names that clash keep the first and warn once without the config', () => {
  const logger = recordingLogger();
  const collection = { configured: true, items: [connector('A b', local('first-mcp', '--key', 'secret-one')), connector('a-b', local('second-mcp', '--key', 'secret-two'))] };
  assert.deepEqual(mcpFragment({ collection, enablement: enabledAll, toEntity: toMcpEntity, logger }), {
    mcp: { servers: { 'mittr-a-b': { type: 'local', command: ['first-mcp', '--key', 'secret-one'] } } },
  });
  assert.equal(logger.warnings.length, 1);
  assert.match(logger.warnings[0], /'a-b'/);
  for (const value of ['first-mcp', 'second-mcp', 'secret-one', 'secret-two', '--key']) assert.equal(logger.warnings[0].includes(value), false, value);
});

test('an entry the engine shape rejects is dropped with a warning that quotes no config', () => {
  const logger = recordingLogger();
  const collection = {
    configured: true,
    items: [
      connector('broken', { command: ['run-me', 'secret-three'], environment: { TOKEN: 'secret-four' } }),
      connector('remote', { type: 'remote', url: '', headers: { authorization: 'secret-five' } }),
      connector('ok', local('ok-mcp')),
      { config: local('nameless') },
    ],
  };
  assert.deepEqual(Object.keys(mcpFragment({ collection, enablement: enabledAll, toEntity: toMcpEntity, logger }).mcp.servers), ['mittr-ok']);
  assert.equal(logger.warnings.length, 3);
  assert.match(logger.warnings[0], /'broken'/);
  assert.match(logger.warnings[1], /'remote'/);
  for (const value of ['run-me', 'secret-three', 'secret-four', 'secret-five', 'TOKEN', 'nameless']) {
    assert.equal(logger.warnings.some((line) => line.includes(value)), false, value);
  }
});

test('an unconfigured or empty collection renders no connector', () => {
  for (const collection of [undefined, null, { configured: false, items: [connector('docs', local('docs-mcp'))] }, { configured: true, items: [] }, { configured: true }]) {
    assert.deepEqual(mcpFragment({ collection, enablement: enabledAll, toEntity: toMcpEntity, logger: recordingLogger() }), {}, JSON.stringify(collection));
  }
});

test('a name the person\'s own config already holds is left out with one line that quotes no config', () => {
  const logger = recordingLogger();
  const held = heldMcpNames({
    configs: [{ mcp: { servers: { 'mittr-docs': { type: 'remote', url: 'https://mine.example', headers: { a: 'own-secret' } } }, 'mittr-old': { type: 'local', command: ['v1'] } } }],
    texts: ['{\n  // mine\n  "mcp": { "servers": { "mittr-notes": { "type": "local", "command": ["mine"] } } }\n}\n', '{ "mcp": { "mittr-law": { "type": "local", "command": ["x"] } } }'],
  });
  const collection = {
    configured: true,
    items: ['docs', 'old', 'notes', 'law', 'free'].map((name) => connector(name, local(`${name}-mcp`, '--key', 'org-secret'))),
  };
  assert.deepEqual(Object.keys(mcpFragment({ collection, enablement: enabledAll, toEntity: toMcpEntity, held, logger }).mcp.servers), ['mittr-free']);
  assert.equal(logger.warnings.length, 4);
  assert.deepEqual(logger.warnings.map((line) => line.match(/'([^']+)'/)[1]), ['docs', 'old', 'notes', 'law']);
  assert.equal(logger.warnings.some((line) => /org-secret|own-secret|-mcp|mine\.example/.test(line)), false);
  assert.equal(logger.warnings.some((line) => /OpenCode|OpenChamber/.test(line)), false);
});

test('names held elsewhere are read from parsed configs, plain JSON, or the quoted name in a JSONC text', () => {
  const held = heldMcpNames({ configs: [{ mcp: { timeout: 5, servers: { a: {} } } }], texts: ['{ "model": "mittr/a1", "mcp": { "servers": {} } }', '/* c */ { "agent": { "x": { "tools": { "mittr-tools-*": false } } }, "mcp": { "mittr-jsonc": {} } }'] });
  assert.equal(held('a'), true);
  assert.equal(held('timeout'), false);
  assert.equal(held('mittr-a1'), false);
  assert.equal(held('mittr-jsonc'), true);
  assert.equal(held('mittr-tools'), false);
  assert.equal(heldMcpNames({})('mittr-x'), false);
});

const memoryUserConfig = (initial) => {
  const state = { config: structuredClone(initial), writes: [] };
  return {
    state,
    read: () => structuredClone(state.config),
    write: (config) => {
      state.writes.push(structuredClone(config));
      state.config = structuredClone(config);
    },
  };
};

test('1.22 org entries named mittr/ are swept from the user config, and the sweep writes nothing after', () => {
  const userConfig = memoryUserConfig({ theme: 'dark', mcp: { 'mittr/docs': { type: 'local', command: ['old'] }, mine: { type: 'local', command: ['mine'] }, servers: { 'mittr-foo': { type: 'remote', url: 'https://mine.example' } } } });
  assert.deepEqual(sweepLegacyUserMcp(userConfig), ['mittr/docs']);
  assert.deepEqual(userConfig.state.config, { theme: 'dark', mcp: { mine: { type: 'local', command: ['mine'] }, servers: { 'mittr-foo': { type: 'remote', url: 'https://mine.example' } } } });
  assert.deepEqual(sweepLegacyUserMcp(userConfig), []);
  assert.equal(userConfig.state.writes.length, 1);

  const onlyLegacy = memoryUserConfig({ mcp: { 'mittr/x': { type: 'local', command: ['x'] } } });
  sweepLegacyUserMcp(onlyLegacy);
  assert.deepEqual(onlyLegacy.state.config, {});
  const none = memoryUserConfig({ model: 'mittr/a1' });
  assert.deepEqual(sweepLegacyUserMcp(none), []);
  assert.equal(none.state.writes.length, 0);
});
