/**
 * Groups items that arrive close together into one provider request.
 *  key      – only items with the same key are batched (e.g. "hi>en")
 *  windowMs – how long to wait for more items before flushing
 *  run(key, texts) must return an array of results in the same order (or throw: every item in the batch is rejected)
 * Identical texts inside one batch share a single slot (cheap de-duplication).
 */
export function createBatcher({ windowMs = 600, maxItems = 8, maxChars = 3000, run }) {
  const groups = new Map();

  async function flush(key) {
    const g = groups.get(key);
    if (!g) return;
    groups.delete(key);
    clearTimeout(g.timer);
    const texts = [...g.slots.keys()];
    try {
      const results = await run(key, texts);
      if (!Array.isArray(results) || results.length !== texts.length) throw new Error('batch result size mismatch');
      texts.forEach((t, i) => g.slots.get(t).forEach(w => w.resolve(results[i])));
    } catch (err) {
      for (const waiters of g.slots.values()) waiters.forEach(w => w.reject(err));
    }
  }

  function add(key, text, { immediate = false } = {}) {
    return new Promise((resolve, reject) => {
      let g = groups.get(key);
      if (!g) { g = { slots: new Map(), chars: 0, timer: null }; groups.set(key, g); g.timer = setTimeout(() => flush(key), windowMs); }
      if (!g.slots.has(text)) { g.slots.set(text, []); g.chars += text.length; }
      g.slots.get(text).push({ resolve, reject });
      if (immediate || g.slots.size >= maxItems || g.chars >= maxChars) void flush(key);
    });
  }
  return { add, flush, pending: () => [...groups.values()].reduce((n, g) => n + g.slots.size, 0) };
}
