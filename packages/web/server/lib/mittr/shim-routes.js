import express from 'express';
import { createStreamMarkupWatcher, describeMarkup } from './response-markup.js';

const reportMarkup = (result, model) => {
  if (result.kind === 'tool-calls-lost') {
    // The failure this whole detector exists for: the model wrote a tool call as
    // text and nothing came back as a call. Nothing else errors, so this line is
    // the only warning anyone gets.
    console.error(
      `[mittr] model ${model} emitted a tool call as text and returned none: ${result.markers.join(' ')}. `
      + 'The gateway tool parser most likely does not match this model.',
    );
    return;
  }
  if (result.kind === 'channel-markup') {
    console.warn(`[mittr] model ${model} leaked markup into content: ${result.markers.join(' ')}`);
  }
};

const bearerOf = (header) => {
  const value = String(header ?? '');
  return value.startsWith('Bearer ') ? value.slice('Bearer '.length).trim() : '';
};

export function registerMittrShimRoutes(app, { upstream, localToken, ensureFreshSession, fetchImpl = fetch }) {
  const requireLocalToken = (req, res, next) => {
    if (bearerOf(req.headers.authorization) !== localToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return next();
  };

  app.post(
    '/v1/chat/completions',
    requireLocalToken,
    express.json({ limit: '32mb' }),
    async (req, res) => {
      const session = await ensureFreshSession();
      if (!session) {
        // The engine cannot prompt anybody, so this message has to be legible
        // where it surfaces: in the developer's chat window.
        return res.status(401).json({ error: 'Not signed in to Mittr. Sign in to continue.' });
      }

      let upstreamResponse;
      try {
        // The local token authenticates the engine to this process and stops
        // here. What travels onward is the developer's own session.
        upstreamResponse = await fetchImpl(`${upstream.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${session.accessToken}`,
          },
          body: JSON.stringify(req.body),
        });
      } catch (error) {
        console.error('[mittr] upstream request failed:', error?.message ?? error);
        return res.status(502).json({ error: 'Cannot reach Mittr' });
      }

      const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json';
      const isStream = Boolean(req.body?.stream) && upstreamResponse.body;

      if (!isStream) {
        const text = await upstreamResponse.text();
        try {
          const message = JSON.parse(text)?.choices?.[0]?.message;
          reportMarkup(
            describeMarkup({
              content: message?.content,
              hasToolCalls: Array.isArray(message?.tool_calls) && message.tool_calls.length > 0,
            }),
            req.body?.model,
          );
        } catch {
          // Inspecting the answer is diagnostics; failing to inspect it must not
          // cost the developer the answer itself.
        }
        res.status(upstreamResponse.status);
        res.setHeader('content-type', contentType);
        return res.send(text);
      }

      res.status(upstreamResponse.status);
      res.setHeader('content-type', contentType);
      res.setHeader('cache-control', 'no-cache, no-transform');
      res.setHeader('connection', 'keep-alive');
      // Anything that buffers this stream turns a live agent into a long pause
      // followed by a wall of text.
      res.setHeader('x-accel-buffering', 'no');
      res.flushHeaders?.();

      // The stream is forwarded untouched. The watcher only reads what goes
      // past and holds a marker's worth of tail, so nothing is buffered and
      // nothing is rewritten.
      const watcher = createStreamMarkupWatcher();
      try {
        for await (const chunk of upstreamResponse.body) {
          res.write(chunk);
          watcher.observe(chunk);
        }
      } catch (error) {
        console.error('[mittr] upstream stream failed:', error?.message ?? error);
      }
      reportMarkup(watcher.finish(), req.body?.model);
      return res.end();
    }
  );
}
