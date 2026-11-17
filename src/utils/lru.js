// Tiny LRU cache (Map preserves insertion order).
export class LRU {
  constructor(max = 2000) { this.max = max; this.map = new Map(); }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key); this.map.delete(key); this.map.set(key, v); return v;
  }
  set(key, value) {
    this.map.delete(key); this.map.set(key, value);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  get size() { return this.map.size; }
}
