// Dependency-free helpers for retry timing. Unit-tested in tests/unit.test.js.

/** "20ms" | "1s" | "6m0s" | "1h2m3.5s" | "12" (seconds) -> milliseconds, or null. */
export function parseDurationMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  let total = 0; let matched = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60000 : n * 3600000;
  }
  return matched ? Math.round(total) : null;
}

const get = (headers, name) => (typeof headers?.get === 'function' ? headers.get(name) : headers?.[name]);

/** How long the provider asked us to wait (Retry-After, retry-after-ms, OpenAI x-ratelimit-reset-*). */
export function retryAfterMs(headers, now = Date.now()) {
  const ms = get(headers, 'retry-after-ms');
  if (ms && /^\d+(\.\d+)?$/.test(String(ms))) return Math.round(Number(ms));
  const ra = get(headers, 'retry-after');
  if (ra) {
    const secs = parseDurationMs(ra);
    if (secs !== null) return secs;
    const date = Date.parse(ra);                       // HTTP-date form
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  for (const h of ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens']) {
    const v = parseDurationMs(get(headers, h));
    if (v !== null) return v;
  }
  return null;
}

/**
 * Exponential backoff with jitter.
 *  - no server hint: "full jitter" -> random in [100, min(cap, base*2^attempt)]
 *  - server hint (minMs): wait AT LEAST that long, plus a small jitter so clients do not all retry together
 */
export function backoffDelay(attempt, { baseMs = 500, capMs = 30000, minMs = 0, rng = Math.random } = {}) {
  const ceiling = Math.min(capMs, baseMs * 2 ** attempt);
  if (minMs > 0) return Math.round(minMs + rng() * Math.min(ceiling, 1000));
  return Math.max(100, Math.floor(rng() * ceiling));
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
