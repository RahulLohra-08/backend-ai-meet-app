import { openaiSpeechAdapter } from './openaiAdapter.js';
import { env } from '../../config/env.js';

// Provider registry: add a new adapter here (it only needs { name, isConfigured(), transcribe() }).
let override = null; // tests inject a fake adapter via setSpeechProvider()
export const setSpeechProvider = adapter => { override = adapter; };

export function getSpeechProvider() {
  if (override) return override;
  return env.STT_PROVIDER === 'none' ? null : openaiSpeechAdapter;
}
export const speechStatus = () => {
  const p = getSpeechProvider();
  return { provider: p?.name || 'none', configured: Boolean(p?.isConfigured()) };
};
