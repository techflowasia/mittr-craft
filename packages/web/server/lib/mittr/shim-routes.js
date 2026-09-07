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

      const text = await upstreamResponse.text();
      res.status(upstreamResponse.status);
      res.setHeader('content-type', upstreamResponse.headers.get('content-type') ?? 'application/json');
      return res.send(text);
    }
  );
}
