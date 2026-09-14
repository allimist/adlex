export class TtlCache {
  constructor(ttlMs = 10000) {
    this.ttl = ttlMs;
    this.map = new Map();
  }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.exp < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key, value) {
    this.map.set(key, { value, exp: Date.now() + this.ttl });
    return value;
  }
  del(key) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}
