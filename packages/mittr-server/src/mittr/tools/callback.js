import { cameThroughProxy, isLoopbackPeer } from '../loopback-guard.js';
import { isRecord } from '../values.js';
import { MittrToolError } from './registry.js';
import { CAPTURE_IMAGE, CAPTURE_TOOL, attachableImage, readCapture, sameDirectory } from './screenshots.js';

export const TOOLS_CALLBACK_ROUTE = '/mittr-tools/v1/call';

const SCHEMA_VERSION = 1;
const UNKNOWN = 'unknown';
const BEARER = 'Bearer ';

const textOrUndefined = (value) => (value === String(value) && value.trim() ? value.trim() : undefined);

const argumentsOf = ({ parameters, ...flattened }, action) => {
  const args = { ...flattened };
  if (isRecord(parameters)) Object.assign(args, parameters);
  args.action = action;
  return args;
};

const sourceOf = (body) => {
  const messageID = textOrUndefined(body.messageID);
  const id = textOrUndefined(body.callID);
  return messageID && id ? { type: 'tool', messageID, id } : undefined;
};

const errorOf = (error) => {
  const status = Number(error?.statusCode) || Number(error?.status) || 500;
  const failure = {
    message: error instanceof Error && error.message ? error.message : 'Action failed',
    kind: status >= 400 && status < 500 ? 'usage' : 'runtime',
  };
  if (error?.code === String(error?.code)) failure.code = error.code;
  if (error?.host === String(error?.host)) failure.host = error.host;
  return { status, error: failure };
};

export function createToolsCallback({ crypto, registry, resolveSessionDirectory, refusalFor, screenshotFolder, logger = console }) {
  const mint = () => crypto.randomBytes(32).toString('base64url');
  let pending = mint();
  let active = null;

  const engineEnv = (port) => ({
    MITTRCRAFT_TOOLS_URL: `http://127.0.0.1:${port}${TOOLS_CALLBACK_ROUTE}`,
    MITTRCRAFT_TOOLS_TOKEN: pending,
  });

  const engineReady = () => {
    active = pending;
    pending = mint();
  };

  const sameToken = (provided, expected) => {
    if (!expected) return false;
    const given = Buffer.from(provided);
    const wanted = Buffer.from(expected);
    return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
  };

  const authorized = (req) => {
    if (!isLoopbackPeer(req.socket?.remoteAddress) || cameThroughProxy(req.headers)) return false;
    const header = req.headers.authorization;
    if (header !== String(header) || !header.startsWith(BEARER)) return false;
    const provided = header.slice(BEARER.length);
    const matchesActive = sameToken(provided, active);
    const matchesPending = sameToken(provided, pending);
    return matchesActive || matchesPending;
  };

  const inflight = new Map();
  const track = (sessionId, controller) => {
    if (!sessionId) return () => {};
    const controllers = inflight.get(sessionId) ?? new Set();
    controllers.add(controller);
    inflight.set(sessionId, controllers);
    return () => {
      controllers.delete(controller);
      if (controllers.size === 0) inflight.delete(sessionId);
    };
  };

  const abortSession = (sessionId) => {
    const controllers = inflight.get(sessionId);
    if (!controllers) return 0;
    for (const controller of controllers) controller.abort();
    return controllers.size;
  };

  const directoryOf = async (sessionId) => {
    if (!sessionId) return undefined;
    try {
      return textOrUndefined(await resolveSessionDirectory(sessionId));
    } catch {
      return undefined;
    }
  };

  const captureImage = async ({ tool, body, sessionId }) => {
    if (tool !== CAPTURE_TOOL) throw new MittrToolError('Only the panel browser tool asks for a capture image', 400);
    const refusal = await refusalFor(tool);
    if (refusal) throw refusal;
    const directory = await directoryOf(sessionId);
    const asked = textOrUndefined(body.directory);
    if (!directory || (asked && !(await sameDirectory(asked, directory)))) throw new MittrToolError('That image is not a saved screenshot of this project', 400);
    return { image: await readCapture({ directory, relativePath: body.path, folder: screenshotFolder }) };
  };

  const handle = async (req, res) => {
    if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    const body = isRecord(req.body) ? req.body : {};
    const tool = textOrUndefined(body.tool);
    const input = isRecord(body.input) ? body.input : {};
    const sessionId = textOrUndefined(body.sessionID);
    if (body.internal === CAPTURE_IMAGE) {
      try {
        return res.json({ schemaVersion: SCHEMA_VERSION, ok: true, action: CAPTURE_IMAGE, data: await captureImage({ tool, body, sessionId }) });
      } catch (error) {
        const failure = errorOf(error);
        logger.warn(`[mittr] tool ${CAPTURE_IMAGE} failed: ${failure.status}`);
        return res.json({ schemaVersion: SCHEMA_VERSION, ok: false, action: CAPTURE_IMAGE, error: failure.error });
      }
    }
    const requested = textOrUndefined(input.action) ?? UNKNOWN;
    const controller = new AbortController();
    const abortOnClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once('aborted', abortOnClose);
    res.once('close', abortOnClose);
    const untrack = track(sessionId, controller);
    let action = null;
    try {
      const refusal = await refusalFor(tool);
      if (refusal) throw refusal;
      const resolved = registry.resolve(input.action, tool);
      if (resolved.error) throw new MittrToolError(resolved.error, 400);
      action = resolved.action;
      const ctx = {
        directory: await directoryOf(sessionId),
        sessionId,
        signal: controller.signal,
        surface: 'agent',
        tool,
        via: 'engine',
      };
      const source = sourceOf(body);
      if (source) ctx.source = source;
      const data = await registry.execute(action, argumentsOf(input, action), ctx);
      return res.json({ schemaVersion: SCHEMA_VERSION, ok: true, action, data: attachableImage(data) });
    } catch (error) {
      const failure = errorOf(error);
      logger.warn(`[mittr] tool ${action ?? UNKNOWN} failed: ${failure.status}`);
      return res.json({ schemaVersion: SCHEMA_VERSION, ok: false, action: action ?? requested, error: failure.error });
    } finally {
      untrack();
      req.off('aborted', abortOnClose);
      res.off('close', abortOnClose);
    }
  };

  return {
    engineEnv,
    engineReady,
    abortSession,
    register(app) {
      app.post(TOOLS_CALLBACK_ROUTE, handle);
    },
  };
}
