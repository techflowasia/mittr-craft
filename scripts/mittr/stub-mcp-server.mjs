#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

export const STUB_TOOL = {
  name: 'lookup',
  description: 'Look up a probe law by its number.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false },
};

export const STUB_ANSWER = { content: [{ type: 'text', text: 'stub-law-41' }] };

const FALLBACK_PROTOCOL = '2025-06-18';

export const handleMessage = (message, { onCall = () => {} } = {}) => {
  if (message?.jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const isRequest = message.id !== undefined && message.id !== null;
  if (!isRequest) return null;
  const reply = (result) => ({ jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'initialize':
      return reply({
        protocolVersion: message.params?.protocolVersion ?? FALLBACK_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'stub-mcp-server', version: '0.0.0' },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: [STUB_TOOL] });
    case 'tools/call':
      if (message.params?.name !== STUB_TOOL.name) {
        return { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `Unknown tool: ${message.params?.name}` } };
      }
      onCall(message.params);
      return reply(STUB_ANSWER);
    default:
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
  }
};

export const argValue = (argv, flag) => {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1] ?? null;
};

const main = () => {
  const logFile = argValue(process.argv, '--log');
  const append = (record) => {
    if (!logFile) return;
    fs.appendFileSync(logFile, `${JSON.stringify({ at: Date.now(), pid: process.pid, cwd: process.cwd(), ...record })}\n`);
  };
  append({ event: 'start' });
  const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const answer = handleMessage(message, { onCall: (params) => append({ event: 'call', tool: params.name, arguments: params.arguments ?? null }) });
    if (answer) write(answer);
  });
  lines.on('close', () => {
    append({ event: 'exit' });
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    append({ event: 'exit', signal: 'SIGTERM' });
    process.exit(0);
  });
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
