export class MittrToolError extends Error {
  constructor(message, statusCode = 500, extra = {}) {
    super(message);
    this.name = 'MittrToolError';
    this.statusCode = statusCode;
    Object.assign(this, extra);
  }
}

export const NO_TOOL_NAME = 'MittrCraft tool call without a tool name';

export const MITTR_TOOLS = Object.freeze({ computer: 'mittrcraft_computer', chrome: 'mittrcraft_chrome', work: 'mittrcraft_work' });

export const UPSTREAM_SWITCHES = Object.freeze({ control: 'control', web: 'web' });

const THIS_MACHINE_ONLY = new Set([MITTR_TOOLS.computer, MITTR_TOOLS.chrome]);
const SCOPED_SURFACES = new Set(['http', 'voice']);

const SURFACES = new Set(['agent', 'voice', 'http']);
const EFFECTS = new Set(['read', 'change']);
const ACTION_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_-]*)+$/;

const bareName = (action) => {
  const separator = action.indexOf('.');
  return separator === -1 ? action : action.slice(separator + 1);
};

export function createMittrActionRegistry({ control, logger = console }) {
  const upstreamActions = new Set(control.all);
  const tools = new Map();
  const actions = new Map();
  let switchRefusal = async () => null;

  const upstreamSwitchOf = (action) => {
    const web = control.definitions?.()?.web ?? [];
    return web.some((definition) => definition.action === action) ? UPSTREAM_SWITCHES.web : UPSTREAM_SWITCHES.control;
  };

  const isAvailable = (entry) => {
    try {
      return Boolean(entry.available());
    } catch {
      logger.warn(`[mittr] ${entry.action} could not tell whether it is available; treated as unavailable`);
      return false;
    }
  };

  const refuseIfSwitchedOff = async (action, surface) => {
    const entry = actions.get(action);
    if (!entry && surface !== 'voice') return;
    const refusal = await switchRefusal(entry ? entry.switchedBy : upstreamSwitchOf(action));
    if (refusal) throw refusal;
  };

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

    register({ action, tool, title, description, effect, voiceOnly = false, switchedBy = tool, available = () => true, execute }) {
      if (!ACTION_NAME.test(action)) throw new Error(`${action} is not a lowercase, dot-separated action name`);
      if (actions.has(action)) throw new Error(`${action} is already registered`);
      if (upstreamActions.has(action)) throw new Error(`${action} is an upstream action`);
      if (!tools.has(tool)) throw new Error(`${tool} is not a defined tool`);
      if (!EFFECTS.has(effect)) throw new Error(`${action} has no effect of read or change`);
      if (!(execute instanceof Function)) throw new Error(`${action} has no execute function`);
      if (!(available instanceof Function)) throw new Error(`${action} has an available that is not a function`);
      actions.set(action, { action, tool, title, description, effect, voiceOnly: voiceOnly === true, switchedBy, available, execute });
    },

    tools() {
      return [...tools.values()]
        .map((tool) => ({
          ...tool,
          definitions: agentActionsOf(tool.name)
            .filter(isAvailable)
            .map(({ action, title, description }) => ({ action, title, description })),
        }))
        .filter((tool) => tool.definitions.length > 0);
    },

    definitions({ tool, includeVoiceOnly = false } = {}) {
      return [...actions.values()]
        .filter((entry) => (tool === undefined || entry.tool === tool) && (includeVoiceOnly || !entry.voiceOnly))
        .map((entry) => ({
          action: entry.action,
          tool: entry.tool,
          title: entry.title,
          description: entry.description,
          effect: entry.effect,
          voiceOnly: entry.voiceOnly,
          available: isAvailable(entry),
        }));
    },

    has(action) {
      return actions.has(action);
    },

    resolve,

    checkSwitch(action, { surface } = {}) {
      return refuseIfSwitchedOff(action, surface);
    },

    useSwitches(refusalOf) {
      if (!(refusalOf instanceof Function)) throw new Error('useSwitches takes a function');
      switchRefusal = refusalOf;
    },

    async execute(action, input, ctx = {}) {
      const { surface } = ctx;
      if (!SURFACES.has(surface)) throw new MittrToolError(`Unknown surface "${surface}"`, 400);
      const entry = actions.get(action);
      if (surface === 'agent') {
        if (!ctx.tool) throw new MittrToolError(NO_TOOL_NAME, 500);
        if (!entry || entry.tool !== ctx.tool || entry.voiceOnly) throw new MittrToolError(unknownAction(action, ctx.tool), 400);
      }
      if (!entry) {
        await refuseIfSwitchedOff(action, surface);
        return control.execute(action, input, ctx.directory, { signal: ctx.signal, contextSessionId: ctx.sessionId });
      }
      if (!isAvailable(entry)) throw new MittrToolError(`${entry.title} is not available in this install`, 503);
      if (entry.voiceOnly && surface !== 'voice') throw new MittrToolError(`${entry.title} can only be asked for by voice`, 400);
      if (SCOPED_SURFACES.has(surface) && THIS_MACHINE_ONLY.has(entry.tool) && ctx.scope?.local !== true) {
        throw new MittrToolError(`${entry.title} can only be used from this machine`, 403);
      }
      await refuseIfSwitchedOff(action, surface);
      return entry.execute(input, ctx);
    },
  };
}
