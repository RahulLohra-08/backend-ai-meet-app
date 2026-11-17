import { backoffDelay, retryAfterMs, sleep as realSleep } from './backoff.js';

// Error raised for every external-provider failure. `retryable` tells callers whether trying again can help.
export class ProviderError extends Error {
  constructor(code, message, status = 502, extra = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code; // NOT_CONFIGURED | RATE_LIMITED | QUOTA_EXCEEDED | UNSUPPORTED_LANGUAGE | TIMEOUT | PROVIDER_ERROR | BAD_RESPONSE | QUEUE_FULL
    this.status = status;
    this.expose = true;
    this.retryAfterMs = extra.retryAfterMs ?? null;
    this.providerCode = extra.providerCode || '';
    this.retryable = extra.retryable ?? ['RATE_LIMITED', 'TIMEOUT', 'PROVIDER_ERROR'].includes(code);
  }
}

const redact = s => String(s || '').replace(/sk-[A-Za-z0-9_\-*]{6,}/g, 'sk-…').replace(/Bearer\s+\S+/gi, 'Bearer …').slice(0, 240);

/** Read the provider's own error explanation ({error:{message,type,code}}) without consuming the response. */
export async function readProviderError(res) {
  try {
    const body = await res.clone().json();
    const e = body?.error ?? body;
    return { type: String(e?.type || ''), code: String(e?.code || ''), message: redact(e?.message || '') };
  } catch { return { type: '', code: '', message: '' }; }
}
// OpenAI answers HTTP 429 both for "slow down" AND for "you have no credit": only the first one is worth retrying.
const isQuota = e => /insufficient_quota|billing_hard_limit|credit/i.test(`${e.type} ${e.code}`) || /exceeded your current quota|billing|no credit|insufficient/i.test(e.message);

/**
 * fetch with timeout, classification of provider errors and bounded retries.
 *  - 429 quota        -> QUOTA_EXCEEDED, never retried
 *  - 429 rate limit   -> retried honouring Retry-After (+jitter); if the provider asks for longer than
 *                        maxDelayMs we stop and hand the wait time to the caller (retryAfterMs)
 *  - 5xx / network    -> exponential backoff with jitter
 */
export async function fetchWithRetry(url, init = {}, { timeoutMs = 20000, retries = 2, baseDelayMs = 500, maxDelayMs = 20000, fetchImpl = fetch, sleep = realSleep, rng = Math.random, onRetry } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status !== 429 && res.status < 500) return res;

      const detail = await readProviderError(res);
      if (res.status === 429 && isQuota(detail)) {
        throw new ProviderError('QUOTA_EXCEEDED', `The AI provider has no remaining quota or credit. Add billing/credit to the account, then retry. Provider said: ${detail.message || detail.code}`, 402, { retryable: false, providerCode: detail.code || detail.type });
      }
      const hint = res.status === 429 ? retryAfterMs(res.headers) : null;
      const wait = backoffDelay(attempt, { baseMs: baseDelayMs, capMs: maxDelayMs, minMs: hint || 0, rng });
      last = res.status === 429
        ? new ProviderError('RATE_LIMITED', `The provider is rate limiting requests${hint ? ` (retry in about ${Math.ceil(hint / 1000)}s)` : ''}.${detail.message ? ` Provider said: ${detail.message}` : ''}`, 429, { retryAfterMs: hint ?? wait, providerCode: detail.code || detail.type })
        : new ProviderError('PROVIDER_ERROR', `The provider returned HTTP ${res.status}.${detail.message ? ` ${detail.message}` : ''}`, 502, { providerCode: detail.code || detail.type });
      if (attempt >= retries || (hint && hint > maxDelayMs)) throw last;
      onRetry?.({ attempt: attempt + 1, waitMs: wait, status: res.status });
      await sleep(wait);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      last = new ProviderError(timedOut ? 'TIMEOUT' : 'PROVIDER_ERROR', timedOut ? 'The provider timed out.' : 'Could not reach the provider (network problem).', 504);
      if (attempt >= retries) throw last;
      const wait = backoffDelay(attempt, { baseMs: baseDelayMs, capMs: maxDelayMs, rng });
      onRetry?.({ attempt: attempt + 1, waitMs: wait, status: 0 });
      await sleep(wait);
    }
  }
  throw last;
}
