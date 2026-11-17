import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

const m = env.NODE_ENV === 'test' ? 1000 : env.RATE_LIMIT_MULTIPLIER;
const make = (windowMs, limit, code, keyGenerator) => rateLimit({
  windowMs, limit: Math.ceil(limit * m), standardHeaders: true, legacyHeaders: false, keyGenerator,
  handler: (_req, res) => res.status(429).json({ error: 'Too many requests. Please slow down and try again shortly.', code })
});

export const apiLimiter = make(15 * 60 * 1000, 600, 'RATE_LIMITED');
export const authLimiter = make(15 * 60 * 1000, 30, 'AUTH_RATE_LIMITED');
// Joining by code is guessable-by-brute-force, so it gets a tighter per-IP budget.
export const joinLimiter = make(10 * 60 * 1000, 40, 'JOIN_RATE_LIMITED');
// Audio chunks arrive every few seconds; budget per authenticated user.
export const audioLimiter = make(60 * 1000, 40, 'AUDIO_RATE_LIMITED', req => `u:${req.user?._id || req.ip}`);
