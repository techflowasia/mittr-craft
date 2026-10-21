import { createHash } from 'node:crypto';

import { isRecord } from './values.js';

const ORG_PREFIX = 'mittr-';
const LEGACY_ORG_PREFIX = 'mittr/';
const NOT_SERVER_KEYS = new Set(['servers', 'timeout']);
const NO_NAME = 'it has no name';
const NOT_RUNNABLE = 'its config is not a connector the engine can run';
const clashing = (serverName) => `another catalog connector already uses the name ${serverName}`;
const heldElsewhere = (serverName) => `an MCP server named ${serverName} is already in the person's own OpenCode config`;

const isNonEmptyText = (item) => item === String(item) && item !== '';

const hasCommand = (raw) => Array.isArray(raw.command) && raw.command.length > 0 && raw.command.every(isNonEmptyText);

const hasUrl = (raw) => Boolean(raw.url?.trim?.());

export const catalogMcpEntity = (raw, toEntity) => {
  if (raw?.type === 'local' && hasCommand(raw)) return toEntity(raw);
  if (raw?.type === 'remote' && hasUrl(raw)) return toEntity(raw);
  return null;
};

export const mcpServerName = (name) => {
  if (typeof name !== 'string' || !name.trim()) return null;
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  return `${ORG_PREFIX}${slug || createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
};

const itemsOf = (collection) => (isRecord(collection) && collection.configured === true && Array.isArray(collection.items) ? collection.items : []);

const leftOutLine = ({ name, error }) => (name === null
  ? `[mittr] a catalog connector was left out: ${error}`
  : `[mittr] catalog connector '${name}' was left out: ${error}`);

const NOTHING_HELD = () => false;

export const catalogMcpServers = ({ collection, enablement, toEntity, held = NOTHING_HELD }) => {
  const servers = new Map();
  const leftOut = [];
  for (const item of itemsOf(collection)) {
    const name = typeof item?.name === 'string' && item.name.trim() ? item.name : null;
    if (name === null) {
      leftOut.push({ name, error: NO_NAME });
      continue;
    }
    if (!enablement.isEnabled('mcp', name)) continue;
    const serverName = mcpServerName(name);
    const entity = catalogMcpEntity(item.config, toEntity);
    if (!entity) {
      leftOut.push({ name, error: NOT_RUNNABLE });
      continue;
    }
    if (servers.has(serverName)) {
      leftOut.push({ name, error: clashing(serverName) });
      continue;
    }
    if (held(serverName)) {
      leftOut.push({ name, error: heldElsewhere(serverName) });
      continue;
    }
    servers.set(serverName, { name, entity });
  }
  return { servers, leftOut };
};

export const mcpFragment = ({ collection, enablement, toEntity, held, logger = console }) => {
  const { servers, leftOut } = catalogMcpServers({ collection, enablement, toEntity, held });
  for (const entry of leftOut) logger.warn(leftOutLine(entry));
  if (servers.size === 0) return {};
  return { mcp: { servers: Object.fromEntries([...servers].map(([serverName, { entity }]) => [serverName, entity])) } };
};

const configHolds = (config, name) => {
  const mcp = isRecord(config) && isRecord(config.mcp) ? config.mcp : null;
  if (!mcp) return false;
  if (isRecord(mcp.servers) && Object.hasOwn(mcp.servers, name)) return true;
  return !NOT_SERVER_KEYS.has(name) && Object.hasOwn(mcp, name);
};

const textHolds = (text, name) => {
  try {
    return configHolds(JSON.parse(text), name);
  } catch {
    return text.includes(JSON.stringify(name));
  }
};

export const heldMcpNames = ({ configs = [], texts = [] }) => (name) => configs.some((config) => configHolds(config, name)) || texts.some((text) => textHolds(text, name));

export const sweepLegacyUserMcp = (userConfig) => {
  const config = userConfig.read();
  if (!isRecord(config.mcp)) return [];
  const legacy = Object.keys(config.mcp).filter((name) => name.startsWith(LEGACY_ORG_PREFIX)).sort();
  if (legacy.length === 0) return [];
  for (const name of legacy) delete config.mcp[name];
  if (Object.keys(config.mcp).length === 0) delete config.mcp;
  userConfig.write(config);
  return legacy;
};
