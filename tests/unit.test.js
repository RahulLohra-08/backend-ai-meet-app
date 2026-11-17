// DB-free unit tests: run with `node --test tests/unit.test.js`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseDurationMs, retryAfterMs, backoffDelay } from '../src/utils/backoff.js';
import { fetchWithRetry, ProviderError } from '../src/utils/http.js';
import { ProviderGate } from '../src/services/ai/gate.js';
import { createBatcher } from '../src/services/translation/batcher.js';
import { chunkLines, parseExplicitDate } from '../src/utils/text.js';

test('parseDurationMs understands OpenAI and plain formats', () => {
  assert.equal(parseDurationMs('20ms'), 20);
  assert.equal(parseDurationMs('1s'), 1000);
  assert.equal(parseDurationMs('6m0s'), 360000);
  assert.equal(parseDurationMs('1h2m3.5s'), 3723500);
  assert.equal(parseDurationMs('12'), 12000);
  assert.equal(parseDurationMs('soon'), null);
  assert.equal(parseDurationMs(''), null);
});

test('retryAfterMs prefers explicit headers and falls back to rate-limit resets', () => {
  assert.equal(retryAfterMs(new Headers({ 'retry-after-ms': '250' })), 250);
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '7' })), 7000);
  assert.equal(retryAfterMs(new Headers({ 'retry-after': new Date(Date.now() + 5000).toUTCString() })) > 3000, true);
  assert.equal(retryAfterMs(new Headers({ 'x-ratelimit-reset-requests': '20s' })), 20000);
  assert.equal(retryAfterMs(new Headers()), null);
});

test('backoffDelay grows exponentially, is capped, jittered, and never below the server hint', () => {
  const max = () => 0.999999, min = () => 0;
  assert.ok(backoffDelay(0, { baseMs: 500, rng: max }) <= 500);
  assert.ok(backoffDelay(3, { baseMs: 500, rng: max }) > 2000 && backoffDelay(3, { baseMs: 500, rng: max }) <= 4000);
  assert.ok(backoffDelay(20, { baseMs: 500, capMs: 30000, rng: max }) <= 30000);
  assert.ok(backoffDelay(2, { rng: min }) >= 100);                           // full jitter never returns ~0
  assert.ok(backoffDelay(0, { minMs: 8000, rng: min }) >= 8000);             // Retry-After is a floor
  const a = backoffDelay(4, { rng: () => 0.2 }), b = backoffDelay(4, { rng: () => 0.8 });
  assert.notEqual(a, b);                                                      // jitter really varies
});

// ---- fake OpenAI-compatible server that replays scripted responses ----
async function scripted(responses) {
  let i = 0; const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(Date.now());
    const r = responses[Math.min(i++, responses.length - 1)];
    res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers || {}) });
    res.end(JSON.stringify(r.body ?? {}));
  });
  await new Promise(r => server.listen(0, r));
  return { url: `http://127.0.0.1:${server.address().port}/x`, seen, close: () => server.close() };
}
const noSleep = () => { const waits = []; return { waits, sleep: async ms => { waits.push(ms); } }; };

test('429 insufficient_quota is NOT retried and is reported as a billing problem, not "rate limiting"', async () => {
  const s = await scripted([{ status: 429, body: { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' } } }]);
  const { sleep, waits } = noSleep();
  await assert.rejects(() => fetchWithRetry(s.url, {}, { retries: 3, sleep }), e => e instanceof ProviderError && e.code === 'QUOTA_EXCEEDED' && e.retryable === false && /billing|credit/i.test(e.message) && e.status === 402);
  assert.equal(s.seen.length, 1); assert.equal(waits.length, 0);
  s.close();
});

test('429 rate limit is retried honouring Retry-After, then succeeds', async () => {
  const s = await scripted([
    { status: 429, headers: { 'retry-after': '3' }, body: { error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } } },
    { status: 429, headers: { 'retry-after-ms': '1500' }, body: { error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } } },
    { status: 200, body: { ok: true } }]);
  const { sleep, waits } = noSleep();
  const res = await fetchWithRetry(s.url, {}, { retries: 3, sleep, rng: () => 0 });
  assert.equal(res.status, 200); assert.equal(s.seen.length, 3);
  assert.ok(waits[0] >= 3000 && waits[1] >= 1500, `waits=${waits}`);
  s.close();
});

test('rate limit that outlasts the retry budget surfaces RATE_LIMITED with the wait time and the provider message', async () => {
  const s = await scripted([{ status: 429, headers: { 'retry-after': '90' }, body: { error: { message: 'Rate limit reached for gpt-4o-mini: Limit 3, Used 3', code: 'rate_limit_exceeded' } } }]);
  const { sleep, waits } = noSleep();
  await assert.rejects(() => fetchWithRetry(s.url, {}, { retries: 3, sleep, maxDelayMs: 20000 }), e => e.code === 'RATE_LIMITED' && e.retryAfterMs >= 90000 && e.retryable && /Limit 3/.test(e.message));
  assert.equal(s.seen.length, 1); assert.equal(waits.length, 0); // did not block for 90 s: caller decides
  s.close();
});

test('5xx and network failures use backoff and eventually raise PROVIDER_ERROR; keys are redacted from messages', async () => {
  const s = await scripted([{ status: 503, body: { error: { message: 'Overloaded. Key sk-proj-abcdef1234567890 was used' } } }]);
  const { sleep, waits } = noSleep();
  await assert.rejects(() => fetchWithRetry(s.url, {}, { retries: 2, sleep }), e => e.code === 'PROVIDER_ERROR' && !/abcdef1234/.test(e.message));
  assert.equal(s.seen.length, 3); assert.equal(waits.length, 2);
  s.close();
  await assert.rejects(() => fetchWithRetry('http://127.0.0.1:9/never', {}, { retries: 1, sleep, timeoutMs: 500 }), e => e.code === 'PROVIDER_ERROR');
});

test('ProviderGate limits concurrency, spaces requests and pauses after a rate-limit answer', async () => {
  let running = 0, peak = 0;
  const gate = new ProviderGate({ maxConcurrent: 2, minIntervalMs: 0 });
  const task = () => async () => { running++; peak = Math.max(peak, running); await new Promise(r => setTimeout(r, 30)); running--; return 'ok'; };
  assert.deepEqual(await Promise.all(Array.from({ length: 6 }, () => gate.run(task()))), Array(6).fill('ok'));
  assert.equal(peak, 2);

  const starts = []; const spaced = new ProviderGate({ maxConcurrent: 5, minIntervalMs: 60 });
  await Promise.all([1, 2, 3].map(() => spaced.run(async () => { starts.push(Date.now()); })));
  assert.ok(starts[1] - starts[0] >= 55 && starts[2] - starts[1] >= 55, `starts=${starts}`);

  const g3 = new ProviderGate({ maxConcurrent: 1 }); let second = 0;
  const t0 = Date.now();
  await assert.rejects(() => g3.run(async () => { throw new ProviderError('RATE_LIMITED', 'slow', 429, { retryAfterMs: 150 }); }));
  await g3.run(async () => { second = Date.now() - t0; });
  assert.ok(second >= 140, `the next request waited the provider's ${second}ms`);

  const small = new ProviderGate({ maxConcurrent: 1, maxQueue: 1 });
  const p1 = small.run(() => new Promise(r => setTimeout(r, 40))); const p2 = small.run(async () => 1);
  await assert.rejects(() => small.run(async () => 2), e => e.code === 'QUEUE_FULL');
  await Promise.all([p1, p2]);
});

test('Batcher: 5 captions arriving together become ONE provider call; duplicates share a slot; failures reject all', async () => {
  const calls = [];
  const b = createBatcher({ windowMs: 40, maxItems: 8, run: async (key, texts) => { calls.push({ key, texts }); return texts.map(t => `T(${t})`); } });
  const out = await Promise.all(['a', 'b', 'c', 'a', 'd'].map(t => b.add('hi>en', t)));
  assert.deepEqual(out, ['T(a)', 'T(b)', 'T(c)', 'T(a)', 'T(d)']);
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].texts, ['a', 'b', 'c', 'd']);

  await Promise.all([b.add('hi>en', 'x'), b.add('en>hi', 'y')]);          // different language pairs are separate batches
  assert.equal(calls.length, 3);

  const full = createBatcher({ windowMs: 5000, maxItems: 2, run: async (k, t) => t });
  const started = Date.now(); await Promise.all([full.add('k', '1'), full.add('k', '2')]);
  assert.ok(Date.now() - started < 1000, 'flushed as soon as the batch was full');

  const bad = createBatcher({ windowMs: 10, run: async () => { throw new ProviderError('RATE_LIMITED', 'x', 429); } });
  const results = await Promise.allSettled([bad.add('k', '1'), bad.add('k', '2')]);
  assert.ok(results.every(r => r.status === 'rejected' && r.reason.code === 'RATE_LIMITED'));
});

test('text helpers', () => {
  assert.equal(chunkLines(['aa', 'bb', 'cc'], 7).length, 2);
  assert.equal(chunkLines(['aa', 'bb', 'cc'], 5).length, 3);
  assert.equal(parseExplicitDate('next friday'), null);
});
