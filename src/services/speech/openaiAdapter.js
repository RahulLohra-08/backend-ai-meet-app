import { env } from '../../config/env.js';
import { fetchWithRetry, ProviderError } from '../../utils/http.js';
import { toLanguageCode } from '../../config/languages.js';

const EXT = { webm: 'webm', ogg: 'ogg', wav: 'wav', mp4: 'mp4', mpeg: 'mp3', mp3: 'mp3', m4a: 'm4a', x: 'wav' };
const extFor = mime => EXT[(mime.split('/')[1] || '').split(';')[0].replace('x-', '')] || 'webm';

/**
 * Adapter for any OpenAI-compatible `/audio/transcriptions` endpoint (OpenAI whisper-1, Groq, faster-whisper-server, ...).
 * verbose_json gives us the detected language and per-segment no_speech_prob so we can drop silence hallucinations.
 */
export const openaiSpeechAdapter = {
  name: 'openai',
  isConfigured: () => env.STT_PROVIDER === 'openai' && Boolean(env.STT_API_KEY),
  async transcribe({ buffer, mimeType = 'audio/webm', language }) {
    if (!this.isConfigured()) throw new ProviderError('NOT_CONFIGURED', 'Speech-to-text is not configured. Set STT_API_KEY (or OPENAI_API_KEY).', 503);
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeType.split(';')[0] }), `chunk.${extFor(mimeType)}`);
    form.append('model', env.STT_MODEL);
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    if (language && language !== 'auto') form.append('language', language);

    const res = await fetchWithRetry(`${env.STT_BASE_URL.replace(/\/$/, '')}/audio/transcriptions`,
      { method: 'POST', headers: { Authorization: `Bearer ${env.STT_API_KEY}` }, body: form },
      { timeoutMs: 45000, retries: 1 });
    if (res.status === 400 || res.status === 422) throw new ProviderError('UNSUPPORTED_AUDIO', 'The speech provider could not decode this audio.', 422);
    if (res.status === 401 || res.status === 403) throw new ProviderError('NOT_CONFIGURED', 'The speech provider rejected the API key.', 503);
    if (!res.ok) throw new ProviderError('PROVIDER_ERROR', `Speech provider returned ${res.status}.`, 502);

    const data = await res.json().catch(() => null);
    if (!data || typeof data.text !== 'string') throw new ProviderError('BAD_RESPONSE', 'Speech provider returned an invalid response.');
    const segments = Array.isArray(data.segments) ? data.segments : [];
    // Whisper tends to "hear" phrases in silence; drop results where every segment is very likely non-speech.
    const mostlySilence = segments.length > 0 && segments.every(s => typeof s.no_speech_prob === 'number' && s.no_speech_prob > 0.6);
    return {
      text: mostlySilence ? '' : data.text.trim(),
      language: toLanguageCode(data.language),
      durationMs: typeof data.duration === 'number' ? Math.round(data.duration * 1000) : null
    };
  }
};
