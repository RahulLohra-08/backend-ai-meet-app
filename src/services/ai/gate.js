import { ProviderError } from '../../utils/http.js';

/**
 * Per-provider request gate: limits concurrency, spaces requests (requests-per-minute) and pauses everyone
 * while the provider has told us to back off. All LLM calls (notes AND translation) share one gate per provider,
 * which is what prevents a burst of captions from exhausting the provider's rate limit.
 */
export class ProviderGate {
  constructor({ maxConcurrent = 2, minIntervalMs = 0, maxQueue = 200, now = Date.now } = {}) {
    Object.assign(this, { maxConcurrent, minIntervalMs, maxQueue, now });
    this.queue = []; this.active = 0; this.lastStart = 0; this.pausedUntil = 0; this.timer = null;
  }
  get size() { return this.queue.length + this.active; }
  /** Stop starting new requests for `ms` (called when the provider answers 429 with a wait time). */
  pause(ms) { this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms); }

  run(task) {
    if (this.queue.length >= this.maxQueue) return Promise.reject(new ProviderError('QUEUE_FULL', 'Too many requests are waiting for the AI provider. Try again shortly.', 503, { retryable: true }));
    return new Promise((resolve, reject) => { this.queue.push({ task, resolve, reject }); this.#pump(); });
  }

  #pump() {
    if (this.timer || this.active >= this.maxConcurrent || !this.queue.length) return;
    const wait = Math.max(this.pausedUntil - this.now(), this.lastStart + this.minIntervalMs - this.now(), 0);
    if (wait > 0) { this.timer = setTimeout(() => { this.timer = null; this.#pump(); }, wait); return; }
    const job = this.queue.shift();
    this.active++; this.lastStart = this.now();
    Promise.resolve().then(job.task).then(job.resolve, err => {
      if (err?.code === 'RATE_LIMITED' && err.retryAfterMs) this.pause(err.retryAfterMs);
      job.reject(err);
    }).finally(() => { this.active--; this.#pump(); });
    this.#pump(); // allow more than one slot to start
  }
}

const gates = new Map();
export function getGate(key, config) {
  if (!gates.has(key)) gates.set(key, new ProviderGate(config));
  return gates.get(key);
}
