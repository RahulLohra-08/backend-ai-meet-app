import { Router } from 'express';
import mongoose from 'mongoose';
import { LANGUAGES } from '../config/languages.js';
import { env } from '../config/env.js';
import { speechStatus } from '../services/speech/index.js';
import { translationStatus } from '../services/translation/index.js';
import { summarizerStatus } from '../services/ai/summarizer.js';

const router = Router();

router.get('/health', (_req, res) => {
  const dbUp = mongoose.connection.readyState === 1;
  res.status(dbUp ? 200 : 503).json({ status: dbUp ? 'ok' : 'degraded', service: 'lingua-meet-api', database: dbUp ? 'connected' : 'disconnected', timestamp: new Date().toISOString() });
});

router.get('/languages', (_req, res) => res.json({ languages: LANGUAGES.map(({ code, name, native, speech }) => ({ code, name, native, speech })) }));

// Lets the frontend (and you) see which providers are really configured instead of guessing.
router.get('/capabilities', (_req, res) => res.json({
  speechToText: speechStatus(),
  translation: translationStatus(),
  notes: summarizerStatus(),
  devMockProviders: env.DEV_MOCK_PROVIDERS,
  browserSpeechEngine: 'client-side (depends on the browser)'
}));

export default router;
