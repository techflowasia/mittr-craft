import path from 'node:path';

import { writeEnginePlugin } from '../private-file.js';
import { CAPTURE_ACTION, CAPTURE_IMAGE, CAPTURE_TIMEOUT_MS, CAPTURE_TOOL, TOO_LARGE, imageContent } from './screenshots.js';

export const TOOLS_PLUGIN_ID = 'mittrcraft-tools';

const SCHEMA_VERSION = 1;
const PLUGIN_DIR = path.join('engine-plugins', TOOLS_PLUGIN_ID);

const inputOf = ({ definitions, parameters }) => ({
  type: 'object',
  properties: {
    action: {
      type: 'string',
      oneOf: definitions.map(({ action, description }) => ({ const: action, description })),
      description: 'MittrCraft action to perform',
    },
    parameters: {
      type: 'object',
      properties: parameters ?? {},
      additionalProperties: false,
      description: 'Inputs for the action; use an empty object when none are needed',
    },
  },
  required: ['action'],
  additionalProperties: true,
});

const toolEntry = (tool, codeMode) => `      tools.add({
        name: ${JSON.stringify(tool.name)},
        description: ${JSON.stringify(tool.description)},
        options: { codemode: ${codeMode ? 'true' : 'false'} },
        input: ${JSON.stringify(inputOf(tool))},
        execute: (input, context) => call(${JSON.stringify(tool.name)}, input, context),
      })
`;

const captureHelpers = (timeoutMs) => `
const CAPTURE_TOOL = ${JSON.stringify(CAPTURE_TOOL)}
const CAPTURE_ACTION = ${JSON.stringify(CAPTURE_ACTION)}
const CAPTURE_IMAGE = ${JSON.stringify(CAPTURE_IMAGE)}
const CAPTURE_TIMEOUT_MS = ${Number(timeoutMs)}
let missingWarned = false

const warnMissing = () => {
  if (missingWarned) return
  missingWarned = true
  console.warn("[mittrcraft] the panel browser tool was not found when the MittrCraft tools loaded; its captures reach the model without their image")
}

const boundedSignal = (signal) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS)
  const stop = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener?.("abort", stop, { once: true })
  return { signal: controller.signal, done: () => { clearTimeout(timer); signal?.removeEventListener?.("abort", stop) } }
}

const textOf = (content) => (typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [])

const capturedPath = (outcome) => {
  if (typeof outcome?.content !== "string") return null
  let envelope = null
  try { envelope = JSON.parse(outcome.content) } catch {}
  return envelope?.ok === true && envelope.action === CAPTURE_ACTION && typeof envelope.data?.path === "string" ? envelope.data.path : null
}

const withCapture = async (outcome, input, context) => {
  const path = capturedPath(outcome)
  const link = connection()
  if (!path || !link) return outcome
  const asked = { ...(input ?? {}), ...(input?.parameters ?? {}) }
  const directory = typeof asked.directory === "string" && asked.directory.trim() ? asked.directory : undefined
  const bounded = boundedSignal(context?.signal)
  try {
    const { answer } = await post(link, { tool: CAPTURE_TOOL, internal: CAPTURE_IMAGE, path, directory, sessionID: context?.sessionID }, bounded.signal)
    const extra = answer?.ok === true ? picture(answer.data?.image, path) : []
    return extra.length === 0 ? outcome : { ...outcome, content: [...textOf(outcome.content), ...extra] }
  } catch {
    return outcome
  } finally {
    bounded.done()
  }
}
`;

const askHelpers = (permissions) => `
const ASK_ALWAYS = ${JSON.stringify(permissions)}

const oneResource = (request) => Array.isArray(request?.resources) && request.resources.length === 1 && typeof request.resources[0] === "string" && request.resources[0] !== "*"

const askAlways = (request) => {
  if (ASK_ALWAYS.includes(request?.action) && request.effect === "allow" && oneResource(request)) request.effect = "ask"
}

const warnNoAsk = () => console.warn("[mittrcraft] the engine cannot be told to ask before a MittrCraft tool uses a site; MittrCraft still refuses every site the user has not allowed")
`;

const askHook = `    if (typeof ctx.permission?.hook === "function") {
      try {
        await ctx.permission.hook("evaluate", askAlways)
      } catch {
        warnNoAsk()
      }
    } else {
      warnNoAsk()
    }
`;

const captureWrap = `      if (typeof tools.get === "function" && typeof tools.update === "function" && tools.get(CAPTURE_TOOL)) {
        tools.update(CAPTURE_TOOL, (tool) => {
          const original = tool.execute
          tool.execute = async (input, context) => withCapture(await original(input, context), input, context)
        })
      } else {
        warnMissing()
      }
`;

export const toolsPluginSource = ({ tools, codeMode, wrapCapture = false, captureTimeoutMs = CAPTURE_TIMEOUT_MS, askPermissions = [] }) => {
  const asks = askPermissions.length > 0;
  const titles = Object.fromEntries(tools.flatMap((tool) => tool.definitions.map(({ action, title }) => [action, title])));
  return `const SCHEMA_VERSION = ${SCHEMA_VERSION}
const TITLES = ${JSON.stringify(titles)}
const TOO_LARGE = ${JSON.stringify(TOO_LARGE)}
const imageContent = ${imageContent}

const connection = () => {
  const endpoint = process.env.MITTRCRAFT_TOOLS_URL
  const token = process.env.MITTRCRAFT_TOOLS_TOKEN
  return endpoint && token ? { endpoint, token } : null
}

const post = async ({ endpoint, token }, body, signal) => {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  })
  const content = await response.text()
  let answer = null
  try { answer = JSON.parse(content) } catch {}
  const valid = answer?.schemaVersion === SCHEMA_VERSION && typeof answer.ok === "boolean" && typeof answer.action === "string"
  return { status: response.status, content, answer: valid ? answer : null }
}

const nameOf = (path) => (typeof path === "string" && path.split("/").pop()) || "screenshot"

const picture = (image, path) => {
  if (image?.tooLarge === true) return typeof path === "string" ? [{ type: "text", text: TOO_LARGE + path }] : []
  if (typeof image?.base64 === "string" && typeof image?.mime === "string") return [imageContent({ base64: image.base64, mime: image.mime, name: nameOf(path) })]
  return []
}

const contentOf = (content, answer) => {
  const image = answer.data?.image
  if (!image || typeof image !== "object") return content
  const { image: _image, ...data } = answer.data
  return [{ type: "text", text: JSON.stringify({ ...answer, data }) }, ...picture(image, data.path)]
}

const titleOf = (action) => (Object.hasOwn(TITLES, action) ? TITLES[action] : action)

const progress = async (context, action, extra) => {
  if (typeof context?.progress !== "function") return
  try {
    await context.progress({ mittrcraft: { schemaVersion: SCHEMA_VERSION, action, description: titleOf(action), ...extra } })
  } catch {}
}

const send = async (tool, input, context, requested) => {
  const result = (content, action, ok) => ({
    content,
    metadata: { mittrcraft: { schemaVersion: SCHEMA_VERSION, action, description: titleOf(action), ok } },
  })
  const failure = (error) => result(JSON.stringify({ schemaVersion: SCHEMA_VERSION, ok: false, action: requested, error }), requested, false)
  const link = connection()
  if (!link) return failure({ message: "The MittrCraft tools connection is unavailable", kind: "runtime" })
  try {
    const { status, content, answer } = await post(link, { tool, input: input ?? {}, sessionID: context.sessionID, messageID: context.messageID, callID: context.id }, context.signal)
    if (answer) return result(contentOf(content, answer), answer.action, answer.ok)
    return failure({ message: "MittrCraft returned an invalid response", kind: "runtime", status })
  } catch (error) {
    return failure({ message: error instanceof Error ? error.message : String(error), kind: "runtime" })
  }
}

const call = async (tool, input, context) => {
  const requested = typeof input?.action === "string" ? input.action : ""
  await progress(context, requested)
  const outcome = await send(tool, input, context, requested)
  const { action, ok } = outcome.metadata.mittrcraft
  await progress(context, action, { ok })
  return outcome
}
${wrapCapture ? captureHelpers(captureTimeoutMs) : ''}${asks ? askHelpers(askPermissions) : ''}
export default {
  id: ${JSON.stringify(TOOLS_PLUGIN_ID)},
  setup: async (ctx) => {
    await ctx.tool.transform((tools) => {
${wrapCapture ? captureWrap : ''}${tools.map((tool) => toolEntry(tool, codeMode)).join('')}    })
${asks ? askHook : ''}  },
}
`;
};

export const toolsPluginDir = (dataDir) => path.join(dataDir, PLUGIN_DIR);

export const materializeToolsPlugin = ({ dataDir, source }) => writeEnginePlugin(toolsPluginDir(dataDir), source);

export const toolsFragment = (dir) => ({ plugins: [dir] });
