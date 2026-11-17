// Minimal structured logger. Callers must never pass passwords, tokens, audio or transcript text.
const levels = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const threshold = () => levels[process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info')] ?? 20;
const SENSITIVE = /pass|token|secret|authorization|cookie|key|text|audio/i;

function clean(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const out = {};
  for (const [k, v] of Object.entries(meta)) out[k] = SENSITIVE.test(k) ? '[redacted]' : v;
  return out;
}
function write(level, msg, meta) {
  if (levels[level] < threshold()) return;
  const line = { t: new Date().toISOString(), level, msg, ...(meta instanceof Error ? { err: meta.message } : clean(meta)) };
  (level === 'error' ? console.error : console.log)(JSON.stringify(line));
}
export const logger = {
  debug: (m, x) => write('debug', m, x),
  info: (m, x) => write('info', m, x),
  warn: (m, x) => write('warn', m, x),
  error: (m, x) => write('error', m, x)
};
