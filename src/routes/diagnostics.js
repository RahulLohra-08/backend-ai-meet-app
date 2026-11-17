import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/httpError.js';
import { probeProviders } from '../services/diagnostics.js';
import { env } from '../config/env.js';

const router = Router();
router.use(requireAuth);
const limiter = rateLimit({ windowMs: 60_000, limit: env.NODE_ENV === 'test' ? 1000 : 5, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => `u:${req.user?._id}`, handler: (_q, res) => res.status(429).json({ error: 'Provider checks are limited to 5 per minute.', code: 'RATE_LIMITED' }) });

// Makes one tiny live request per configured provider and reports what the provider REALLY answered.
router.post('/providers', limiter, asyncHandler(async (_req, res) => res.json(await probeProviders())));
export default router;
