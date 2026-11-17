// Single source of truth for languages the app can handle.
// `whisper` is the English language name returned by Whisper-style speech APIs (verbose_json),
// `speech` is the BCP-47 tag used by the browser SpeechRecognition API.
export const LANGUAGES = [
  { code: 'en', name: 'English',    native: 'English',    speech: 'en-US', whisper: 'english' },
  { code: 'hi', name: 'Hindi',      native: 'हिन्दी',      speech: 'hi-IN', whisper: 'hindi' },
  { code: 'bn', name: 'Bengali',    native: 'বাংলা',       speech: 'bn-IN', whisper: 'bengali' },
  { code: 'mr', name: 'Marathi',    native: 'मराठी',       speech: 'mr-IN', whisper: 'marathi' },
  { code: 'ta', name: 'Tamil',      native: 'தமிழ்',       speech: 'ta-IN', whisper: 'tamil' },
  { code: 'te', name: 'Telugu',     native: 'తెలుగు',      speech: 'te-IN', whisper: 'telugu' },
  { code: 'ur', name: 'Urdu',       native: 'اردو',        speech: 'ur-IN', whisper: 'urdu' },
  { code: 'fr', name: 'French',     native: 'Français',   speech: 'fr-FR', whisper: 'french' },
  { code: 'de', name: 'German',     native: 'Deutsch',    speech: 'de-DE', whisper: 'german' },
  { code: 'es', name: 'Spanish',    native: 'Español',    speech: 'es-ES', whisper: 'spanish' },
  { code: 'it', name: 'Italian',    native: 'Italiano',   speech: 'it-IT', whisper: 'italian' },
  { code: 'pt', name: 'Portuguese', native: 'Português',  speech: 'pt-PT', whisper: 'portuguese' },
  { code: 'ja', name: 'Japanese',   native: '日本語',      speech: 'ja-JP', whisper: 'japanese' },
  { code: 'ko', name: 'Korean',     native: '한국어',      speech: 'ko-KR', whisper: 'korean' },
  { code: 'zh', name: 'Chinese',    native: '中文',        speech: 'zh-CN', whisper: 'chinese' },
  { code: 'ar', name: 'Arabic',     native: 'العربية',     speech: 'ar-SA', whisper: 'arabic' }
];

const byCode = new Map(LANGUAGES.map(l => [l.code, l]));
const byWhisper = new Map(LANGUAGES.map(l => [l.whisper, l]));

export const LANGUAGE_CODES = LANGUAGES.map(l => l.code);
export const isSupportedLanguage = code => byCode.has(code);
export const languageName = code => byCode.get(code)?.name || code;
/** Convert a Whisper language name ("hindi") or ISO code ("hi") into our ISO code, or null. */
export function toLanguageCode(value) {
  if (!value || typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (byCode.has(v)) return v;
  return byWhisper.get(v)?.code || null;
}
