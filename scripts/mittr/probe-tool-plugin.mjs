import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MARKER_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR42mP4z8DAAMIM/////w8AH+4F+2BscPIAAAAASUVORK5CYII=';
export const MARKER_SHA256 = createHash('sha256').update(Buffer.from(MARKER_PNG, 'base64')).digest('hex');
export const PROBE_HOST = 'probe.example.test';
export const HOOKED_HOST = 'hooked.example.test';
export const PROBE_PERMISSION = 'mittrcraft_chrome';
export const PROBE_ASK_MESSAGE = (host) => `Allow the agent to use your Chrome sign-in on ${host}?`;
export const WRAP_MARKER = 'probe-wrapped';

export const imagePart = (base64, mime, name) => ({ type: 'file', uri: `data:${mime};base64,${base64}`, mime, name });
export const PROVEN_IMAGE_PART = imagePart(MARKER_PNG, 'image/png', 'probe.png');
export const LEGACY_ATTACHMENT = { type: 'file', mime: 'image/png', url: PROVEN_IMAGE_PART.uri, filename: 'probe.png' };

export const PROBE_TOOL_NAMES = [
  'mittr_probe_direct',
  'mittr_probe_code',
  'mittr_probe_image',
  'mittr_probe_image_code',
  'mittr_probe_image_legacy',
  'mittr_probe_ask',
  'mittr_probe_permission_option',
  'mittr_probe_wait',
];

export const writePlugin = (dir, name, source) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name, version: '0.0.0', private: true, type: 'module', exports: { '.': './index.js' } }, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'index.js'), source, { mode: 0o600 });
};

const OBJECT_INPUT = { type: 'object', properties: {}, additionalProperties: true };
const ASK_INPUT = {
  type: 'object',
  properties: { variant: { type: 'string', enum: ['a', 'b', 'c', 'e'] }, host: { type: 'string' } },
  required: ['variant', 'host'],
  additionalProperties: false,
};

const toolEntry = ({ name, codemode, body, input = OBJECT_INPUT, extraOptions = {} }) => `    tools.add({
      name: ${JSON.stringify(name)},
      description: ${JSON.stringify(`MittrCraft probe tool ${name}.`)},
      options: ${JSON.stringify({ codemode, ...extraOptions })},
      input: ${JSON.stringify(input)},
      async execute(input, context) {
        await record({ kind: "execute", tool: ${JSON.stringify(name)}, sessionID: context?.sessionID ?? null, context: contextFacts(context) })
${body}
      },
    })
`;

const textResult = (expression) => `        return { content: [{ type: "text", text: JSON.stringify(${expression}) }] }`;

const ENTRIES = {
  mittr_probe_direct: toolEntry({ name: 'mittr_probe_direct', codemode: false, body: textResult('{ tool: "mittr_probe_direct", envType: typeof process.env.MITTRCRAFT_TOOLS_URL }') }),
  mittr_probe_code: toolEntry({ name: 'mittr_probe_code', codemode: true, body: textResult('{ tool: "mittr_probe_code", envType: typeof process.env.MITTRCRAFT_TOOLS_URL }') }),
  mittr_probe_image: toolEntry({ name: 'mittr_probe_image', codemode: false, body: `        return { content: [{ type: "text", text: '{"ok":true}' }, ${JSON.stringify(PROVEN_IMAGE_PART)}] }` }),
  mittr_probe_image_code: toolEntry({ name: 'mittr_probe_image_code', codemode: true, body: `        return { content: [{ type: "text", text: '{"ok":true}' }, ${JSON.stringify(PROVEN_IMAGE_PART)}] }` }),
  mittr_probe_image_legacy: toolEntry({ name: 'mittr_probe_image_legacy', codemode: false, body: `        return { content: '{"ok":true}', attachments: [${JSON.stringify(LEGACY_ATTACHMENT)}] }` }),
  mittr_probe_ask: toolEntry({
    name: 'mittr_probe_ask',
    codemode: false,
    input: ASK_INPUT,
    body: `        const outcome = await askBy(input.variant, input.host, context)
        await record({ kind: "ask-outcome", sessionID: context?.sessionID ?? null, variant: input.variant, outcome })
${textResult('{ tool: "mittr_probe_ask", variant: input.variant, outcome }')}`,
  }),
  mittr_probe_permission_option: toolEntry({
    name: 'mittr_probe_permission_option',
    codemode: false,
    extraOptions: { permission: PROBE_PERMISSION },
    body: textResult('{ tool: "mittr_probe_permission_option", ran: true }'),
  }),
  mittr_probe_wait: toolEntry({
    name: 'mittr_probe_wait',
    codemode: false,
    body: `        const startedAt = Date.now()
        const sessionID = context?.sessionID ?? null
        context.signal?.addEventListener?.("abort", () => { void record({ kind: "wait-signal-aborted", sessionID, afterMs: Date.now() - startedAt }) }, { once: true })
        try {
          const response = await fetch(process.env.MITTR_PROBE_HANG_URL, { signal: context.signal })
          await record({ kind: "wait-outcome", sessionID, outcome: "answered", status: response.status })
        } catch (error) {
          await record({ kind: "wait-outcome", sessionID, outcome: "threw", name: error?.name ?? null, message: String(error?.message ?? error) })
        }
${textResult('{ tool: "mittr_probe_wait", done: true }')}`,
  }),
};

export const probeToolPluginSource = ({ include = PROBE_TOOL_NAMES } = {}) => `const recordUrl = process.env.MITTR_PROBE_RECORD_URL
const record = async (entry) => {
  if (!recordUrl) return
  try {
    await fetch(recordUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ at: Date.now(), ...entry }) })
  } catch {}
}
const keysOf = (value) => {
  if (value === null || value === undefined) return { own: [], proto: [] }
  const proto = Object.getPrototypeOf(value)
  return { own: Object.keys(value).sort(), proto: proto && proto !== Object.prototype ? Object.getOwnPropertyNames(proto).sort() : [] }
}
const nestedKeys = (value) => Object.fromEntries(Object.keys(value ?? {}).filter((key) => value[key] && typeof value[key] === "object").map((key) => [key, Object.keys(value[key]).sort()]))
const contextFacts = (context) => ({ keys: keysOf(context), signal: Object.prototype.toString.call(context?.signal), askType: typeof context?.ask })
const settle = async (run) => {
  try {
    return { outcome: "resolved", value: await run() }
  } catch (error) {
    return { outcome: "threw", name: error?.name ?? null, message: String(error?.message ?? error) }
  }
}
let setupContext = null
const askBy = (variant, host, context) => {
  context.signal?.addEventListener?.("abort", () => { void record({ kind: "ask-signal-aborted", sessionID: context.sessionID, variant }) }, { once: true })
  if (variant === "a") return settle(() => context.ask({ permission: ${JSON.stringify(PROBE_PERMISSION)}, patterns: [host], always: [host], metadata: { host } }))
  if (variant === "b") return settle(() => context.ask({ action: ${JSON.stringify(PROBE_PERMISSION)}, resources: [host], save: [host], message: "Allow the agent to use your Chrome sign-in on " + host + "?", metadata: { host } }))
  if (variant === "c") {
    const api = setupContext?.permission ?? {}
    const method = ["ask", "create", "assert", "request"].find((name) => typeof api[name] === "function")
    if (!method) return Promise.resolve({ outcome: "unavailable", permissionKeys: Object.keys(api).sort() })
    return settle(() => api[method]({ sessionID: context.sessionID, action: ${JSON.stringify(PROBE_PERMISSION)}, resources: [host], save: [host], metadata: { host } })).then((result) => ({ method, ...result }))
  }
  return settle(async () => {
    const response = await fetch(new URL("/probe/ask", recordUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionID: context.sessionID, host, messageID: context.messageID, callID: context.id, agent: context.agent }), signal: context.signal })
    return await response.json()
  })
}
const textOf = (content) => (typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [])

export default {
  id: "mittrcraft-probe-tools",
  setup: async (ctx) => {
    setupContext = ctx
    await record({ kind: "setup", ctx: keysOf(ctx), nested: nestedKeys(ctx) })
    await ctx.tool.transform((tools) => {
      const listed = typeof tools.list === "function" ? tools.list().map((tool) => tool.name) : null
      const web = typeof tools.get === "function" ? tools.get(${JSON.stringify('openchamber_web')}) : undefined
      const wrap = { found: Boolean(web), updated: false, error: null }
      if (web && typeof tools.update === "function") {
        try {
          tools.update(${JSON.stringify('openchamber_web')}, (tool) => {
            const original = tool.execute
            tool.execute = async (input, context) => {
              const result = await original(input, context)
              await record({ kind: "wrap-ran" })
              return { ...result, content: [...textOf(result?.content), { type: "text", text: ${JSON.stringify(WRAP_MARKER)} }] }
            }
          })
          wrap.updated = true
        } catch (error) {
          wrap.error = String(error?.message ?? error)
        }
      }
      void record({ kind: "transform", tools: keysOf(tools), listed, wrap })
${include.map((name) => ENTRIES[name]).join('')}    })
    if (typeof ctx.permission?.hook === "function") {
      try {
        await ctx.permission.hook("evaluate", (request) => {
          if (request?.action !== ${JSON.stringify(PROBE_PERMISSION)} || !Array.isArray(request.resources) || !request.resources.includes(${JSON.stringify(HOOKED_HOST)})) return
          const effectSeen = request.effect ?? null
          if (request.effect === "allow") request.effect = "ask"
          void record({ kind: "evaluate-hook", keys: keysOf(request), effectSeen, effectLeft: request.effect ?? null })
        })
        await record({ kind: "evaluate-hook-registered" })
      } catch (error) {
        await record({ kind: "evaluate-hook-error", message: String(error?.message ?? error) })
      }
    }
  },
}
`;

export const writeProbeToolPlugin = (dir, options = {}) => writePlugin(dir, 'mittrcraft-probe-tools', probeToolPluginSource(options));
