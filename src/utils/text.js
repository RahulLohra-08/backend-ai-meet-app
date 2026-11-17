// Pure helpers (no dependencies) so they are easy to unit test.
/** Split transcript lines into chunks no longer than maxChars, never splitting inside a line. */
export function chunkLines(lines, maxChars = 40000) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const raw of lines) {
    const line = raw.length > maxChars ? raw.slice(0, maxChars) : raw;
    const len = line.length + 1;
    if (size + len > maxChars && current.length) { chunks.push(current); current = []; size = 0; }
    current.push(line);
    size += len;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
export const normalizeText = s => String(s || '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
/** Accept only an explicit calendar date (YYYY-MM-DD); return a Date or null. Never guesses. */
export function parseExplicitDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return null;
  const d = new Date(`${value.trim()}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.getUTCFullYear() < 2000 ? null : d;
}
