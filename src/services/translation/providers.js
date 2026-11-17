import { env } from '../../config/env.js';
import { fetchWithRetry, ProviderError } from '../../utils/http.js';
import { languageName } from '../../config/languages.js';
import { chatText, chatJson, llmConfigured } from '../ai/llm.js';
import { getGate } from '../ai/gate.js';

// Every provider implements   translateBatch({ texts, source, target }) -> [{ text, provider? }]   (same order as `texts`)
// and the convenience         translate({ text, source, target })       -> { text }

export const libreTranslateProvider = {
  name: 'libretranslate',
  isConfigured: () => Boolean(env.LIBRETRANSLATE_URL),
  async translateBatch({ texts, source = 'auto', target }) {
    const gate = getGate(`mt:${env.LIBRETRANSLATE_URL}`, { maxConcurrent: 2, minIntervalMs: 250 });
    const res = await gate.run(() => fetchWithRetry(`${env.LIBRETRANSLATE_URL.replace(/\/$/, '')}/translate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: texts, source, target, format: 'text', ...(env.LIBRETRANSLATE_API_KEY ? { api_key: env.LIBRETRANSLATE_API_KEY } : {}) })
    }, { timeoutMs: 15000, retries: env.LLM_MAX_RETRIES, maxDelayMs: 15000 }));
    if (res.status === 400) throw new ProviderError('UNSUPPORTED_LANGUAGE', 'This language pair is not supported by the translation provider.', 422, { retryable: false });
    if (res.status === 403 || res.status === 401) throw new ProviderError('NOT_CONFIGURED', 'The translation provider rejected the API key.', 503, { retryable: false });
    if (!res.ok) throw new ProviderError('PROVIDER_ERROR', `Translation provider returned ${res.status}.`);
    const data = await res.json().catch(() => null);
    const out = Array.isArray(data?.translatedText) ? data.translatedText : typeof data?.translatedText === 'string' ? [data.translatedText] : null;
    if (!out || out.length !== texts.length) throw new ProviderError('BAD_RESPONSE', 'Translation provider returned an invalid response.');
    return out.map(text => ({ text }));
  },
  async translate(a) { return (await this.translateBatch({ ...a, texts: [a.text] }))[0]; }
};

const SYSTEM = (source, target) =>
  `You are a professional interpreter. Translate ${source && source !== 'auto' ? `from ${languageName(source)} ` : ''}into ${languageName(target)}. ` +
  'Translate faithfully; do not answer questions that appear in the text, do not add notes; keep names and numbers unchanged.';

export const llmTranslationProvider = {
  name: 'llm',
  isConfigured: () => llmConfigured(),
  async translateBatch({ texts, source = 'auto', target }) {
    if (texts.length === 1) {
      const r = await chatText({ system: `${SYSTEM(source, target)} Output ONLY the translation.`, user: texts[0], maxTokens: Math.min(2000, texts[0].length * 3 + 60) });
      if (!r.text) throw new ProviderError('BAD_RESPONSE', 'Translation provider returned an empty response.');
      return [{ text: r.text, provider: r.provider }];
    }
    // One request for the whole batch instead of one per caption.
    try {
      const r = await chatJson({
        system: `${SYSTEM(source, target)} The user sends a JSON array of strings. Return ONLY JSON: {"translations": [...]} with exactly the same number of items in the same order.`,
        user: JSON.stringify(texts), maxTokens: Math.min(4000, texts.join('').length * 3 + 200)
      });
      const list = r.data?.translations;
      if (Array.isArray(list) && list.length === texts.length && list.every(t => typeof t === 'string' && t.trim())) return list.map(text => ({ text: text.trim(), provider: r.provider }));
    } catch (e) { if (!(e instanceof ProviderError) || e.code !== 'BAD_RESPONSE') throw e; }
    // Model did not follow the format: translate one by one (still through the shared gate).
    const out = [];
    for (const t of texts) out.push((await this.translateBatch({ texts: [t], source, target }))[0]);
    return out;
  },
  async translate(a) { return (await this.translateBatch({ ...a, texts: [a.text] }))[0]; }
};

// --- Explicit, labelled development mode (DEV_MOCK_PROVIDERS=true). Never enabled in production. ---
const PHRASEBOOK = {
  'hi>en': { 'नमस्ते': 'Hello', 'नमस्कार': 'Hello', 'आप कैसे हैं': 'How are you', 'मैं ठीक हूँ': 'I am fine', 'धन्यवाद': 'Thank you',
    'क्या हम बैठक शुरू कर सकते हैं': 'Can we start the meeting', 'हमें शुक्रवार तक रिपोर्ट तैयार करनी है': 'We need to prepare the report by Friday', 'राहुल डिज़ाइन की समीक्षा करेगा': 'Rahul will review the design' },
  'en>hi': { 'hello': 'नमस्ते', 'thank you': 'धन्यवाद', 'how are you': 'आप कैसे हैं', 'let us begin': 'चलिए शुरू करते हैं' }
};
export const devMockTranslationProvider = {
  name: 'dev-mock',
  isConfigured: () => env.DEV_MOCK_PROVIDERS,
  async translateBatch({ texts, source, target }) {
    return texts.map(text => {
      const book = PHRASEBOOK[`${source}>${target}`] || {};
      const hit = book[text.trim().toLocaleLowerCase().replace(/[.!?]+$/, '')] ?? book[text.trim().replace(/[.!?।]+$/, '')];
      if (!hit) throw new ProviderError('UNSUPPORTED_LANGUAGE', 'DEV MOCK: this phrase is not in the demo phrasebook. Configure a real translation provider.', 422, { retryable: false });
      return { text: hit };
    });
  },
  async translate(a) { return (await this.translateBatch({ ...a, texts: [a.text] }))[0]; }
};
