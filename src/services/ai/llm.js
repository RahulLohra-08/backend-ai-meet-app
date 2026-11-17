import { env } from '../../config/env.js';
import { fetchWithRetry, ProviderError } from '../../utils/http.js';
import { getGate } from './gate.js';

let override = null; // tests inject { chatJson, chatText, configured, name, model }
export const setLlm = impl => { override = impl; };

const host = url => { try { return new URL(url).hostname; } catch { return url; } };

/** Providers in priority order. The fallback exists only if its key AND base URL AND model are all set. */
export function llmProviders() {
  const list = [];
  if (env.OPENAI_API_KEY) list.push({ role: 'primary', name: host(env.OPENAI_BASE_URL), baseUrl: env.OPENAI_BASE_URL, key: env.OPENAI_API_KEY, model: env.OPENAI_MODEL });
  if (env.LLM_FALLBACK_API_KEY && env.LLM_FALLBACK_BASE_URL && env.LLM_FALLBACK_MODEL) {
    list.push({ role: 'fallback', name: host(env.LLM_FALLBACK_BASE_URL), baseUrl: env.LLM_FALLBACK_BASE_URL, key: env.LLM_FALLBACK_API_KEY, model: env.LLM_FALLBACK_MODEL });
  }
  return list;
}
export const llmConfigured = () => (override ? override.configured !== false : llmProviders().length > 0);
export const llmModelName = () => (override?.model || llmProviders()[0]?.model || env.OPENAI_MODEL);
export const llmProviderName = () => (override?.name || llmProviders()[0]?.name || 'openai-compatible');
export const llmFallbackConfigured = () => llmProviders().some(p => p.role === 'fallback');

const FALLBACK_ON = new Set(['RATE_LIMITED', 'QUOTA_EXCEEDED', 'TIMEOUT', 'PROVIDER_ERROR']);

async function callProvider(p, { system, user, json, maxTokens }) {
  const res = await fetchWithRetry(`${p.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
    body: JSON.stringify({
      model: p.model, temperature: 0.2, max_tokens: maxTokens,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
    })
  }, { timeoutMs: 90000, retries: env.LLM_MAX_RETRIES, maxDelayMs: 20000 });
  if (res.status === 401 || res.status === 403) throw new ProviderError('NOT_CONFIGURED', `The AI provider (${p.name}) rejected the API key.`, 503, { retryable: false });
  if (!res.ok) throw new ProviderError('PROVIDER_ERROR', `AI provider ${p.name} returned HTTP ${res.status}.`, 502);
  const data = await res.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new ProviderError('BAD_RESPONSE', 'AI provider returned an invalid response.');
  return content;
}

/** One request through the provider's gate (concurrency + requests/minute + shared back-off). Falls back only when configured. */
async function complete(args) {
  const providers = llmProviders();
  if (!providers.length) throw new ProviderError('NOT_CONFIGURED', 'AI is not configured. Set OPENAI_API_KEY (any OpenAI-compatible provider works).', 503, { retryable: false });
  let last;
  for (const p of providers) {
    const gate = getGate(`llm:${p.baseUrl}`, { maxConcurrent: env.LLM_MAX_CONCURRENCY, minIntervalMs: Math.ceil(60000 / env.LLM_MAX_RPM) });
    try { return { text: await gate.run(() => callProvider(p, args)), provider: p.name, model: p.model, role: p.role }; }
    catch (e) { last = e; if (!(e instanceof ProviderError) || !FALLBACK_ON.has(e.code)) throw e; }
  }
  throw last;
}

/** Returns { text, provider, model } */
export async function chatText(args) {
  if (override?.chatText) return { text: await override.chatText(args), provider: override.name || 'test', model: override.model || 'test' };
  const r = await complete({ ...args, json: false });
  return { ...r, text: r.text.trim() };
}

/** Returns { data, provider, model } */
export async function chatJson(args) {
  if (override?.chatJson) return { data: await override.chatJson(args), provider: override.name || 'test', model: override.model || 'test' };
  const r = await complete({ ...args, json: true });
  try { return { data: JSON.parse(r.text.replace(/^```(?:json)?\s*|\s*```$/g, '')), provider: r.provider, model: r.model }; }
  catch { throw new ProviderError('BAD_RESPONSE', 'AI provider returned malformed JSON.'); }
}
