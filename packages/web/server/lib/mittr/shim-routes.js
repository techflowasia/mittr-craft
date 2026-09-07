import express from 'express';

const bearerOf = (header) => {
  const value = String(header ?? '');
  return value.startsWith('Bearer ') ? value.slice('Bearer '.length).trim() : '';
};

export function registerMittrShimRoutes(app, { upstream, localToken, fetchImpl = fetch }) {
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
      let upstreamResponse;
      try {
        // The local token authenticates the engine to this process and stops
        // here. Only the upstream credential travels onward.
        upstreamResponse = await fetchImpl(`${upstream.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${upstream.token}`,
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

      try {
        for await (const chunk of upstreamResponse.body) {
          res.write(chunk);
        }
      } catch (error) {
        console.error('[mittr] upstream stream failed:', error?.message ?? error);
      }
      return res.end();
    }
  );
}
