import { env } from '../config/env.js';
import { llmProviders } from './ai/llm.js';
import { readProviderError } from '../utils/http.js';

/** Pure: turn an HTTP status + provider error into a verdict a human can act on. */
export function classifyProbe(status, err = {}) {
  const text = `${err.type || ''} ${err.code || ''} ${err.message || ''}`;
  if (status >= 200 && status < 300) return { verdict: 'ok', advice: 'The key works and the provider answered.' };
  if (status === 401 || status === 403) return { verdict: 'invalid_key', advice: 'The provider rejected the API key. Create a new key and put it in backend/.env, then restart the backend.' };
  if (status === 429 && /insufficient_quota|exceeded your current quota|billing|credit/i.test(text)) return { verdict: 'quota_exceeded', advice: 'The account has no credit/quota. Add a payment method or credit in the provider dashboard. Retrying cannot help until this is fixed.' };
  if (status === 429) return { verdict: 'rate_limited', advice: 'Genuine rate limit (common on accounts without billing: only a few requests per minute). Lower LLM_MAX_RPM (e.g. 3), add billing, or configure LLM_FALLBACK_*.' };
  if (status === 404) return { verdict: 'model_not_found', advice: 'The model name is not available for this key. Check OPENAI_MODEL / STT_MODEL.' };
  if (status === 0) return { verdict: 'unreachable', advice: 'Could not reach the provider from the server (firewall, DNS, proxy or wrong base URL).' };
  return { verdict: 'error', advice: `The provider returned HTTP ${status}.` };
}

const RL = ['x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests', 'retry-after'];
async function request(url, init) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
    const err = res.ok ? {} : await readProviderError(res);
    return { status: res.status, err, limits: Object.fromEntries(RL.map(h => [h, res.headers.get(h)]).filter(([, v]) => v)) };
  } catch { return { status: 0, err: {}, limits: {} }; }
}

/** Sends at most one tiny request per configured provider. Never returns or logs an API key. */
export async function probeProviders() {
  const out = { llm: [], speechToText: null, translation: null };
  for (const p of llmProviders()) {
    const base = p.baseUrl.replace(/\/$/, '');
    const auth = { Authorization: `Bearer ${p.key}` };
    const models = await request(`${base}/models`, { headers: auth });
    const chat = await request(`${base}/chat/completions`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: p.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }) });
    out.llm.push({ role: p.role, provider: p.name, model: p.model, keyCheck: { httpStatus: models.status, ...classifyProbe(models.status, models.err) }, chatCheck: { httpStatus: chat.status, providerMessage: chat.err.message || undefined, rateLimitHeaders: chat.limits, ...classifyProbe(chat.status, chat.err) } });
  }
  if (!out.llm.length) out.llm.push({ verdict: 'not_configured', advice: 'Set OPENAI_API_KEY in backend/.env.' });

  if (env.STT_PROVIDER === 'openai' && env.STT_API_KEY) {
    const m = await request(`${env.STT_BASE_URL.replace(/\/$/, '')}/models`, { headers: { Authorization: `Bearer ${env.STT_API_KEY}` } });
    out.speechToText = { provider: new URL(env.STT_BASE_URL).hostname, model: env.STT_MODEL, httpStatus: m.status, note: 'Checks the key only; transcription itself is billed per audio minute and is not probed.', ...classifyProbe(m.status, m.err) };
  } else out.speechToText = { verdict: 'not_configured', advice: 'Set STT_API_KEY to enable the server speech engine. The browser engine needs no key.' };

  if (env.LIBRETRANSLATE_URL) {
    const l = await request(`${env.LIBRETRANSLATE_URL.replace(/\/$/, '')}/languages`, {});
    out.translation = { provider: 'libretranslate', httpStatus: l.status, ...classifyProbe(l.status, l.err) };
  } else out.translation = { provider: llmProviders().length ? 'llm (uses the same key and limits as notes)' : 'none', verdict: llmProviders().length ? 'see llm' : 'not_configured' };
  return out;
}
