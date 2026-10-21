export class MittrToolError extends Error {
  constructor(message, statusCode = 500, extra = {}) {
    super(message);
    this.name = 'MittrToolError';
    this.statusCode = statusCode;
    Object.assign(this, extra);
  }
}

const SURFACES = new Set(['agent', 'voice', 'http']);
const EFFECTS = new Set(['read', 'change']);

const bareName = (action) => {
  const separator = action.indexOf('.');
  return separator === -1 ? action : action.slice(separator + 1);
};

const upstreamActionsOf = (control) => {
  const { control: controlDefinitions, web } = control.definitions();
  return new Set([...controlDefinitions, ...web].map(({ action }) => action));
};

export function createMittrActionRegistry({ control }) {
  const upstreamActions = upstreamActionsOf(control);
  const tools = new Map();
  const actions = new Map();

  const agentActionsOf = (toolName) => [...actions.values()].filter((entry) => entry.tool === toolName && !entry.voiceOnly);

  const unknownAction = (requested, toolName) => {
    const known = agentActionsOf(toolName).map(({ action }) => action);
    return `Unknown action "${requested}" for ${toolName}; it has: ${known.join(', ')}`;
  };

  const resolve = (requested, toolName) => {
    const value = requested === String(requested) ? requested.trim() : '';
    const known = agentActionsOf(toolName);
    const exact = known.find(({ action }) => action === value);
    if (exact) return { action: exact.action };
    const matches = known.filter(({ action }) => bareName(action) === value);
    if (value && matches.length === 1) return { action: matches[0].action };
    return { error: unknownAction(value, toolName) };
  };

  return {
    defineTool({ name, description, parameters }) {
      if (tools.has(name)) throw new Error(`${name} is already defined`);
      tools.set(name, { name, description, parameters });
    },

    register({ action, tool, title, description, effect, voiceOnly = false, available = () => true, execute }) {
      if (actions.has(action)) throw new Error(`${action} is already registered`);
      if (upstreamActions.has(action)) throw new Error(`${action} is an upstream action`);
      if (!tools.has(tool)) throw new Error(`${tool} is not a defined tool`);
      if (!EFFECTS.has(effect)) throw new Error(`${action} has no effect of read or change`);
      actions.set(action, { action, tool, title, description, effect, voiceOnly: voiceOnly === true, available, execute });
    },

    tools() {
      return [...tools.values()]
        .map((tool) => ({
          ...tool,
          definitions: agentActionsOf(tool.name)
            .filter((entry) => entry.available())
            .map(({ action, title, description }) => ({ action, title, description })),
        }))
        .filter((tool) => tool.definitions.length > 0);
    },

    definitions({ tool, includeVoiceOnly = false } = {}) {
      return [...actions.values()]
        .filter((entry) => (tool === undefined || entry.tool === tool) && (includeVoiceOnly || !entry.voiceOnly))
        .map(({ action, tool: toolName, title, description, effect, voiceOnly }) => ({ action, tool: toolName, title, description, effect, voiceOnly }));
    },

    has(action) {
      return actions.has(action);
    },

    resolve,

    async execute(action, input, ctx = {}) {
      const { surface } = ctx;
      if (!SURFACES.has(surface)) throw new MittrToolError(`Unknown surface "${surface}"`, 400);
      const entry = actions.get(action);
      if (surface === 'agent' && (!entry || entry.tool !== ctx.tool || entry.voiceOnly)) {
        throw new MittrToolError(unknownAction(action, ctx.tool), 400);
      }
      if (!entry) {
        return control.execute(action, input, ctx.directory, { signal: ctx.signal, contextSessionId: ctx.sessionId });
      }
      if (!entry.available()) throw new MittrToolError(`${entry.title} is not available in this install`, 503);
      if (entry.voiceOnly && surface !== 'voice') throw new MittrToolError(`${entry.title} can only be asked for by voice`, 400);
      return entry.execute(input, ctx);
    },
  };
}
