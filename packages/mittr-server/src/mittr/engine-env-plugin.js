import path from 'node:path';

import { writeEnginePlugin } from './private-file.js';

export const ENGINE_ENV_PLUGIN_ID = 'mittrcraft-engine-env';

const PLUGIN_DIR = path.join('engine-plugins', ENGINE_ENV_PLUGIN_ID);

export const TOOLS_TOKEN_SLOT = 'mittrcraft.tools.token';
export const AGENT_TOOL_TOKEN_SLOT = 'openchamber.agent-tool.token';

export const KEPT_FOR_THE_ENGINE = Object.freeze({
  MITTRCRAFT_TOOLS_TOKEN: TOOLS_TOKEN_SLOT,
  OPENCHAMBER_AGENT_TOOL_TOKEN: AGENT_TOOL_TOKEN_SLOT,
});

export const DROPPED_FOR_CHILDREN = Object.freeze(['OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD', 'OPENCHAMBER_SERVICE_TOKEN']);

export const ENGINE_CHILD_SECRETS = Object.freeze([...Object.keys(KEPT_FOR_THE_ENGINE), ...DROPPED_FOR_CHILDREN]);

export const keepFromChildrenSource = `const keepFromChildren = (name, slot) => {
  const value = process.env[name]
  if (value !== undefined) globalThis[Symbol.for(slot)] = value
  delete process.env[name]
  return globalThis[Symbol.for(slot)]
}
`;

export const engineEnvPluginSource = () => `${keepFromChildrenSource}
for (const [name, slot] of Object.entries(${JSON.stringify(KEPT_FOR_THE_ENGINE)})) keepFromChildren(name, slot)
for (const name of ${JSON.stringify(DROPPED_FOR_CHILDREN)}) delete process.env[name]

const LIBC = { darwin: "/usr/lib/libSystem.B.dylib", linux: "libc.so.6" }[process.platform]
if (LIBC && typeof Bun !== "undefined") {
  try {
    const { dlopen, FFIType } = await import("bun:ffi")
    const libc = dlopen(LIBC, { unsetenv: { args: [FFIType.cstring], returns: FFIType.i32 } })
    for (const name of ${JSON.stringify(ENGINE_CHILD_SECRETS)}) libc.symbols.unsetenv(Buffer.from(name + "\\0"))
  } catch {}
}

export default {
  id: ${JSON.stringify(ENGINE_ENV_PLUGIN_ID)},
  setup: async () => {},
}
`;

export const engineEnvPluginDir = (dataDir) => path.join(dataDir, PLUGIN_DIR);

export const materializeEngineEnvPlugin = ({ dataDir }) => writeEnginePlugin(engineEnvPluginDir(dataDir), engineEnvPluginSource());

export const engineEnvFragment = (dir) => ({ plugins: [dir] });
