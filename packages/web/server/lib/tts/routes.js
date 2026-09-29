import express from 'express';
import { normalizeCustomOpenAIBaseURL } from './base-url.js';
import { summarizeText, sanitizeForTTS, sanitizeForNote } from '../text/summarization.js';
import { parsePcmRateFromFormat, pcm16ToWav } from '../dictation/audio.js';

const MITTR_SYNTHESIZE_MAX_CHARS = 4000;
const MITTR_PCM_DEFAULT_RATE = 24000;

const fitMittrText = (text) => {
  if (text.length <= MITTR_SYNTHESIZE_MAX_CHARS) return text;
  const lastKept = text.charCodeAt(MITTR_SYNTHESIZE_MAX_CHARS - 1);
  const safeEnd = lastKept >= 0xd800 && lastKept <= 0xdbff ? MITTR_SYNTHESIZE_MAX_CHARS - 1 : MITTR_SYNTHESIZE_MAX_CHARS;
  const head = text.slice(0, safeEnd);
  const boundary = head.search(/\s\S*$/);
  return (boundary > 0 ? head.slice(0, boundary) : head).trimEnd();
};

const readPcmChannels = (contentType) => {
  const match = /(?:^|[;,\s])channels\s*=\s*(\d+)/i.exec(contentType);
  return match ? Number.parseInt(match[1], 10) : 1;
};

const speakWithMittr = async (req, res, getMittrSpeechClient) => {
  const client = getMittrSpeechClient();
  if (!client) {
    return res.status(503).json({ error: 'The Mittr platform cannot be reached right now', reasonCode: 'unreachable' });
  }
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) {
    return res.status(400).json({ error: 'Text is required' });
  }

  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });

  try {
    const { body, contentType } = await client.synthesize(fitMittrText(text), abort.signal);
    const mediaType = contentType.split(';')[0].trim().toLowerCase();
    if (!mediaType.startsWith('audio/')) {
      return res.status(502).json({ error: 'The Mittr platform returned no audio', reasonCode: 'upstream_failed' });
    }
    const audio = Buffer.from(await new Response(body).arrayBuffer());
    let payload = audio;
    let payloadType = contentType;
    if (mediaType === 'audio/pcm' || mediaType === 'audio/l16') {
      if (readPcmChannels(contentType) !== 1) {
        return res.status(502).json({ error: 'The Mittr platform returned audio this app cannot play', reasonCode: 'upstream_failed' });
      }
      const samples = Buffer.from(audio.subarray(0, audio.length & ~1));
      if (mediaType === 'audio/l16') samples.swap16();
      payload = pcm16ToWav(samples, parsePcmRateFromFormat(contentType, MITTR_PCM_DEFAULT_RATE));
      payloadType = 'audio/wav';
    }
    res.setHeader('Content-Type', payloadType);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', payload.length);
    return res.send(payload);
  } catch (error) {
    if (abort.signal.aborted || res.headersSent) return undefined;
    const reasonCode = typeof error?.reasonCode === 'string' ? error.reasonCode : 'upstream_failed';
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502;
    return res.status(status).json({ error: error instanceof Error ? error.message : 'Speech failed', reasonCode });
  }
};

export function registerTtsRoutes(app, { sayTTSCapability, getMittrSpeechClient = () => null }) {
  let ttsModulePromise = null;
  const getTtsModule = async () => {
    if (!ttsModulePromise) {
      ttsModulePromise = import('./index.js');
    }
    return ttsModulePromise;
  };

  app.post('/api/voice/token', async (req, res) => {
    console.log('[Voice] Token request received:', {
      contentType: req.headers['content-type'] || null,
    });
    try {
      const openaiApiKey = process.env.OPENAI_API_KEY;
      console.log('[Voice] OpenAI API Key present:', !!openaiApiKey);

      if (!openaiApiKey) {
        return res.status(503).json({
          allowed: false,
          error: 'OpenAI voice service not configured. Set OPENAI_API_KEY environment variable.'
        });
      }

      // Return success - OpenAI TTS is available
      res.json({
        allowed: true,
        provider: 'openai',
        message: 'OpenAI TTS is available'
      });
    } catch (error) {
      console.error('[Voice] Token generation error:', error);
      res.status(500).json({
        allowed: false,
        error: 'Voice service error'
      });
    }
  });

  // Server-side TTS endpoint - streams audio from OpenAI TTS API
  app.post('/api/tts/speak', async (req, res) => {
    try {
      if (req.body?.providerId === 'mittr') {
        return speakWithMittr(req, res, getMittrSpeechClient);
      }
      const { text, voice = 'nova', model = 'gpt-4o-mini-tts', speed = 0.9, instructions, apiKey, baseURL } = req.body || {};

      const normalizedBaseURLResult = normalizeCustomOpenAIBaseURL(baseURL);
      if (normalizedBaseURLResult.error) {
        return res.status(400).json({ error: normalizedBaseURLResult.error });
      }
      const normalizedBaseURL = normalizedBaseURLResult.value;

      console.log('[TTS] Request received:', { voice, model, speed, textLength: text?.length, hasApiKey: !!apiKey, hasBaseURL: !!baseURL });

      if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'Text is required' });
      }

      // Dynamically import the TTS service (ESM)
      const { ttsService } = await getTtsModule();

      // Check availability - server-configured key, client-provided key, or custom server URL
      const hasServerKey = ttsService.isAvailable();
      const hasClientKey = apiKey && typeof apiKey === 'string' && apiKey.trim().length > 0;
      const hasCustomBaseURL = typeof normalizedBaseURL === 'string' && normalizedBaseURL.length > 0;
      
      if (!hasServerKey && !hasClientKey && !hasCustomBaseURL) {
        return res.status(503).json({ 
          error: 'TTS service not available. Please configure OpenAI in OpenCode, provide an API key, or set a custom server URL in settings.' 
        });
      }

      let textToSpeak = text.trim();

      // Historical summarize request fields are intentionally ignored. The
      // model-backed summarization provider is retired.

      const result = await ttsService.generateSpeechStream({
        text: textToSpeak,
        voice,
        model,
        speed,
        instructions,
        apiKey: hasClientKey ? apiKey.trim() : undefined,
        baseURL: hasCustomBaseURL ? normalizedBaseURL : undefined,
      });

      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Content-Length', result.buffer.length);
      res.send(result.buffer);
      } catch (error) {
        console.error('[TTS] Error:', error);
        if (!res.headersSent) {
          const { model: m, voice: v, baseURL: b } = req.body || {};
          res.status(500).json({ 
            error: error instanceof Error ? error.message : 'TTS generation failed',
            detail: { model: m, voice: v, hasBaseURL: !!b },
          });
        }
      }
  });

  app.post('/api/text/summarize', async (req, res) => {
    try {
      const { text, threshold = 200, maxLength = 500, mode } = req.body || {};

      if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'Text is required' });
      }

      const result = await summarizeText({
        text,
        threshold,
        maxLength,
        mode: typeof mode === 'string' ? mode : 'tts',
      });

      return res.json(result);
    } catch (error) {
      console.error('[Summarize] Error:', error);
      const sanitized = typeof req.body?.mode === 'string' && req.body.mode === 'note'
        ? sanitizeForNote(req.body?.text || '')
        : sanitizeForTTS(req.body?.text || '');
      return res.json({ summary: sanitized, summarized: false, reason: error.message });
    }
  });

       
  // TTS status endpoint
  app.get('/api/tts/status', async (_req, res) => {
    try {
      const { ttsService } = await getTtsModule();
      res.json({
        available: ttsService.isAvailable(),
        voices: [
          'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable',
          'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'
        ]
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to check TTS status' });
    }
  });

  // The startup probe runs concurrently with server bootstrap. An unusually
  // early status request waits for that same authoritative result.
  app.get('/api/tts/say/status', async (_req, res) => {
    res.json(await sayTTSCapability);
  });

  // macOS 'say' command TTS speak endpoint
  app.post('/api/tts/say/speak', async (req, res) => {
    try {
      const { text, voice = 'Samantha', rate = 200 } = req.body || {};
      
      if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'Text is required' });
      }
      
      // Check if we're on macOS
      if (process.platform !== 'darwin') {
        return res.status(503).json({ error: 'macOS say command not available on this platform' });
      }
      
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      const execAsync = promisify(exec);
      
      // Create temp file for audio output (use m4a for browser compatibility)
      const tempDir = os.tmpdir();
      const tempFile = path.join(tempDir, `say-${Date.now()}.m4a`);
      
      // Escape text for shell - escape both single quotes and double quotes
      const escapedText = text.trim().replace(/'/g, "'\\''").replace(/"/g, '\\"');
      
      // Generate audio file using 'say' command
      // -o outputs to file, -r sets rate (words per minute)
      // --data-format=aac outputs as m4a which browsers can decode
      const cmd = `say -v "${voice}" -r ${rate} -o "${tempFile}" --data-format=aac '${escapedText}'`;
      console.log('[TTS-Say] Generating speech:', { textLength: text.length, voice, rate });
      
      await execAsync(cmd);
      
      // Read the generated audio file
      const audioBuffer = await fs.promises.readFile(tempFile);
      
      // Clean up temp file
      fs.promises.unlink(tempFile).catch(() => {});
      
      // Send audio response
      res.setHeader('Content-Type', 'audio/mp4');
      res.setHeader('Content-Length', audioBuffer.length);
      res.send(audioBuffer);
      
    } catch (error) {
      console.error('[TTS-Say] Error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Say command failed'
      });
    }
  });

  // Server-side STT: receive raw audio, proxy to OpenAI-compatible transcription endpoint
  app.post(
    '/api/stt/transcribe',
    express.raw({ type: (req) => (req.headers['content-type'] || '').startsWith('audio/'), limit: '20mb' }),
    async (req, res) => {
      try {
        const { transcribeAudio } = await import('./stt.js');

        const mimeType = (req.headers['content-type'] || 'audio/webm').split(',')[0].trim();
        const baseURL = typeof req.headers['x-base-url'] === 'string' ? req.headers['x-base-url'].trim() : '';
        const model = typeof req.headers['x-model'] === 'string' && req.headers['x-model'].trim().length > 0
          ? req.headers['x-model'].trim()
          : 'deepdml/faster-whisper-large-v3-turbo-ct2';
        const language = typeof req.headers['x-language'] === 'string' && req.headers['x-language'].trim().length > 0
          ? req.headers['x-language'].trim()
          : undefined;
        const authHeader = typeof req.headers['authorization'] === 'string' ? req.headers['authorization'].trim() : '';
        const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;

        if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
          return res.status(400).json({ error: 'Audio data is required' });
        }

        if (!baseURL) {
          return res.status(400).json({ error: 'X-Base-URL header is required' });
        }

        console.log('[STT] Transcribing audio:', {
          bytes: req.body.length,
          mimeType,
          model,
          baseURL,
          language,
          hasApiKey: !!apiKey,
        });

        const transcript = await transcribeAudio({
          audioBuffer: req.body,
          mimeType,
          model,
          baseURL,
          apiKey,
          language,
        });

        console.log('[STT] Transcript:', transcript?.slice(0, 120));
        res.json({ transcript: transcript ?? '' });
      } catch (error) {
        console.error('[STT] Error:', error);
        if (!res.headersSent) {
          res.status(500).json({
            error: error instanceof Error ? error.message : 'Transcription failed',
          });
        }
      }
    }
  );
}
