import { jsonBody } from '../json-body.js';
import { cameThroughProxy, isLoopbackPeer } from '../loopback-guard.js';
import { isRecord } from '../values.js';
import { MittrToolError } from './registry.js';

const ROUTE = '/api/mittr/control';
const BODY_LIMIT = '1mb';
const ACTION_FAILED = 'Action failed';
export const SESSION_FROM_THIS_MACHINE_ONLY = 'A session can be named only from this machine';

const isControlError = (error, ControlError) => typeof ControlError === 'function' && error instanceof ControlError;

const asToolError = (error, ControlError) => {
  if (error instanceof MittrToolError) return error;
  const message = error instanceof Error && error.message ? error.message : ACTION_FAILED;
  const partial = isControlError(error, ControlError) && error.partial === true ? {
    partial: true,
    partialAction: error.partialAction,
    sessionId: error.sessionId,
    directory: error.directory,
  } : {};
  return new MittrToolError(message, Number(error?.statusCode) || Number(error?.status) || 500, partial);
};

const textOrUndefined = (value) => (value === String(value) ? value : undefined);

const failureBody = (failure) => {
  const body = { error: failure.message };
  if (failure.code === String(failure.code)) body.code = failure.code;
  if (failure.host === String(failure.host)) body.host = failure.host;
  if (failure.partial === true) {
    Object.assign(body, {
      partial: true,
      partialAction: failure.partialAction,
      sessionId: failure.sessionId,
      directory: failure.directory,
    });
  }
  return body;
};

export const isLocalRequest = (req, { host, requestScope }) => Boolean(host)
  && requestScope(req) === 'local'
  && isLoopbackPeer(req.socket?.remoteAddress)
  && !cameThroughProxy(req.headers);

export function registerMittrControlRoutes(app, { express, registry, host, requestScope, ControlError }) {
  app.post(ROUTE, jsonBody(express, { limit: BODY_LIMIT }), async (req, res) => {
    const controller = new AbortController();
    const abortOnDisconnect = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once('aborted', abortOnDisconnect);
    res.once('close', abortOnDisconnect);
    try {
      const local = isLocalRequest(req, { host, requestScope });
      const sessionId = textOrUndefined(req.body?.contextSessionId);
      if (sessionId !== undefined && !local) throw new MittrToolError(SESSION_FROM_THIS_MACHINE_ONLY, 400);
      const action = textOrUndefined(req.body?.action) ?? '';
      const input = isRecord(req.body?.input) ? req.body.input : {};
      const data = await registry.execute(action, input, {
        directory: textOrUndefined(req.body?.contextDirectory),
        sessionId,
        signal: controller.signal,
        surface: 'http',
        scope: { local },
      });
      return res.json(data);
    } catch (error) {
      const failure = asToolError(error, ControlError);
      return res.status(failure.statusCode).json(failureBody(failure));
    } finally {
      req.off('aborted', abortOnDisconnect);
      res.off('close', abortOnDisconnect);
    }
  });
}
