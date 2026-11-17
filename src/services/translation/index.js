import { createHash } from 'node:crypto';
import Translation from '../../models/Translation.js';
import { env } from '../../config/env.js';
import { LRU } from '../../utils/lru.js';
import { ProviderError } from '../../utils/http.js';
import { createBatcher } from './batcher.js';
import { libreTranslateProvider, llmTranslationProvider, devMockTranslationProvider } from './providers.js';

let override = null; // tests inject a fake provider
export const setTranslationProvider = p => { override = p; };

export function getTranslationProvider() {
  if (override) return override;
  const choice = env.TRANSLATION_PROVIDER;
  if (choice === 'none') return null;
  if (choice === 'libretranslate') return libreTranslateProvider;
  if (choice === 'llm') return llmTranslationProvider;
  // auto: prefer a dedicated MT service, then an LLM, then (dev only) the labelled mock
  if (libreTranslateProvider.isConfigured()) return libreTranslateProvider;
  if (llmTranslationProvider.isConfigured()) return llmTranslationProvider;
  if (devMockTranslationProvider.isConfigured()) return devMockTranslationProvider;
  return null;
}
export const translationStatus = () => {
  const p = getTranslationProvider();
  return { provider: p?.name || 'none', configured: Boolean(p?.isConfigured()), devMock: p?.name === 'dev-mock' };
};

const cache = new LRU(3000);       // identical (source,target,text) across meetings are translated once
const inflight = new Map();         // transcriptId:target -> Promise, prevents duplicate provider calls
const hash = (s, t, text) => createHash('sha1').update(`${s}|${t}|${text}`).digest('hex');

// Captions that arrive within a short window for the same language pair go to the provider as ONE request.
async function runBatch(key, texts) {
  const [providerName, source, target] = key.split('|');
  const provider = getTranslationProvider();
  if (!provider || provider.name !== providerName) throw new ProviderError('PROVIDER_ERROR', 'Translation provider changed while a batch was waiting.');
  if (typeof provider.translateBatch === 'function') return provider.translateBatch({ texts, source, target });
  const out = [];                                   // simple providers (tests, custom adapters): one call per text
  for (const text of texts) out.push(await provider.translate({ text, source, target }));
  return out;
}
let batcher = null;
const getBatcher = () => (batcher ||= createBatcher({ windowMs: env.TRANSLATION_BATCH_WINDOW_MS, maxItems: env.TRANSLATION_BATCH_MAX, run: runBatch }));

/**
 * Translate a stored transcript into `target`. Returns
 *   { status: 'translated', text, provider, targetLanguage } | { status: 'same_language' }
 * Throws ProviderError on failure (see `retryable` / `retryAfterMs`). Successful results are persisted.
 * { immediate: true } skips the batching window (used for an explicit user "Retry").
 */
export async function translateTranscript(transcript, target, { immediate = false } = {}) {
  const source = transcript.detectedLanguage || (transcript.sourceLanguage !== 'auto' ? transcript.sourceLanguage : 'auto');
  if (source === target) return { status: 'same_language', targetLanguage: target };

  const existing = await Translation.findOne({ transcript: transcript._id, targetLanguage: target });
  if (existing) return { status: 'translated', text: existing.text, provider: existing.provider, targetLanguage: target };

  const key = `${transcript._id}:${target}`;
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    const provider = getTranslationProvider();
    if (!provider || !provider.isConfigured()) {
      throw new ProviderError('NOT_CONFIGURED', 'Translation is not configured. Set LIBRETRANSLATE_URL or an LLM key (see README).', 503, { retryable: false });
    }
    const ck = hash(source, target, transcript.text);
    let hit = cache.get(ck);
    if (!hit) {
      const out = await getBatcher().add(`${provider.name}|${source}|${target}`, transcript.text, { immediate });
      hit = { text: out.text, provider: out.provider || provider.name };
      cache.set(ck, hit);
    }
    try {
      await Translation.create({ meeting: transcript.meeting, transcript: transcript._id, sourceLanguage: source, targetLanguage: target, text: hit.text, provider: hit.provider });
    } catch (e) { if (e?.code !== 11000) throw e; } // concurrent writer already stored it
    return { status: 'translated', text: hit.text, provider: hit.provider, targetLanguage: target };
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}
