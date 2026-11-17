import 'dotenv/config';
import { z } from 'zod';

const bool = (def = 'false') => z.enum(['true', 'false']).default(def).transform(v => v === 'true');
const optionalUrl = z.union([z.literal(''), z.string().url()]).default('');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  FRONTEND_URL: z.string().min(1).default('http://localhost:5173'), // comma-separated allow-list
  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/lingua_meet'),
  DNS_SERVERS: z.string().default(''), // optional workaround for Atlas SRV lookups, e.g. "8.8.8.8,8.8.4.4"
  TRUST_PROXY: bool(),

  // --- Auth ---
  JWT_SECRET: z.string().min(24).default('development-only-change-this-secret-12345'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_SECURE: z.enum(['true', 'false', 'auto']).default('auto'),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

  // --- Speech-to-text (OpenAI-compatible /audio/transcriptions: OpenAI, Groq, self-hosted faster-whisper servers...) ---
  STT_PROVIDER: z.enum(['openai', 'none']).default('openai'),
  STT_API_KEY: z.string().default(''),
  STT_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  STT_MODEL: z.string().default('whisper-1'),

  // --- Translation ---
  TRANSLATION_PROVIDER: z.enum(['auto', 'libretranslate', 'llm', 'none']).default('auto'),
  LIBRETRANSLATE_URL: optionalUrl,
  LIBRETRANSLATE_API_KEY: z.string().default(''),

  // --- LLM (translation fallback + meeting notes), OpenAI-compatible chat completions ---
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),

  // --- LLM traffic control (shared by notes and translation) ---
  // OpenAI accounts without billing are limited to a handful of requests per minute: set LLM_MAX_RPM=3 if you are on that tier.
  LLM_MAX_RPM: z.coerce.number().int().min(1).default(20),
  LLM_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(2),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(8).default(3),
  // Optional second provider (any OpenAI-compatible API). Used ONLY when it is configured and the primary fails with
  // rate-limit / quota / outage errors. Results always record which provider produced them.
  LLM_FALLBACK_API_KEY: z.string().default(''),
  LLM_FALLBACK_BASE_URL: z.string().default(''),
  LLM_FALLBACK_MODEL: z.string().default(''),
  TRANSLATION_BATCH_WINDOW_MS: z.coerce.number().int().min(0).default(700),
  TRANSLATION_BATCH_MAX: z.coerce.number().int().min(1).max(20).default(6),
  TRANSLATION_AUTO_RETRIES: z.coerce.number().int().min(0).max(6).default(3),
  DUPLICATE_WINDOW_MS: z.coerce.number().int().min(0).default(4000),

  // --- Behaviour ---
  SUMMARY_AUTO_ON_END: bool('true'),
  RETENTION_DAYS: z.coerce.number().int().min(0).default(0), // 0 = keep forever
  DEV_MOCK_PROVIDERS: bool(), // explicit, labelled, never allowed in production
  DEV_EXPOSE_RESET_LINK: bool(), // return password-reset link in the API response (development only)
  RATE_LIMIT_MULTIPLIER: z.coerce.number().positive().default(1)
});

export const env = schema.parse(process.env);

// Fall back to the generic OpenAI key for STT when a dedicated one is not set.
env.STT_API_KEY = env.STT_API_KEY || env.OPENAI_API_KEY;
env.frontendOrigins = env.FRONTEND_URL.split(',').map(s => s.trim()).filter(Boolean);

if (env.NODE_ENV === 'production') {
  if (env.JWT_SECRET.startsWith('development-only') || env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be a unique random value of at least 32 characters in production.');
  }
  if (env.DEV_MOCK_PROVIDERS || env.DEV_EXPOSE_RESET_LINK) {
    throw new Error('DEV_MOCK_PROVIDERS and DEV_EXPOSE_RESET_LINK must not be enabled in production.');
  }
}
