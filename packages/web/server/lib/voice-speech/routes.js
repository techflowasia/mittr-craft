const TRANSCRIBE_UPLOAD_LIMIT = '25mb';

const unreachableReadiness = {
  listen: false,
  speak: false,
  voice: false,
  signedIn: false,
  voiceSilenceMs: null,
  reason: 'unreachable',
};

const toWireReadiness = (readiness) => ({
  listen: readiness.ready?.listen === true,
  speak: readiness.ready?.speak === true,
  voice: readiness.ready?.voice === true,
  signedIn: readiness.signedIn === true,
  voiceSilenceMs: Number.isFinite(readiness.voiceSilenceMs) ? readiness.voiceSilenceMs : null,
  reason: readiness.reason ?? null,
});

const readAudioField = async (req) => {
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.toLowerCase().startsWith('multipart/form-data') || !Buffer.isBuffer(req.body) || req.body.length === 0) {
    return null;
  }
  const form = await new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: req.body,
  }).formData().catch(() => null);
  const audio = form?.get('audio');
  if (!audio || typeof audio === 'string' || audio.size === 0) return null;
  return Buffer.from(await audio.arrayBuffer());
};

export function registerVoiceSpeechRoutes(app, { express, getMittrSpeechClient }) {
  app.get('/api/voice/readiness', async (_req, res) => {
    const client = getMittrSpeechClient();
    if (!client) {
      res.json(unreachableReadiness);
      return;
    }
    try {
      res.json(toWireReadiness(await client.readiness()));
    } catch {
      res.json(unreachableReadiness);
    }
  });

  app.post(
    '/api/voice/transcribe',
    express.raw({ type: 'multipart/form-data', limit: TRANSCRIBE_UPLOAD_LIMIT }),
    async (req, res) => {
      const client = getMittrSpeechClient();
      if (!client) {
        res.status(503).json({ error: 'The Mittr platform cannot be reached right now', reasonCode: 'unreachable' });
        return;
      }
      const audio = await readAudioField(req);
      if (!audio) {
        res.status(400).json({ error: 'A WAV file in the audio field is required', reasonCode: 'bad_request' });
        return;
      }
      const abort = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) abort.abort();
      });
      try {
        const text = await client.transcribe(audio, abort.signal);
        res.json({ text });
      } catch (error) {
        if (abort.signal.aborted || res.headersSent) return;
        const reasonCode = typeof error?.reasonCode === 'string' ? error.reasonCode : 'upstream_failed';
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502;
        res.status(status).json({ error: error instanceof Error ? error.message : 'Transcription failed', reasonCode });
      }
    },
  );
}
