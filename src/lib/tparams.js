/**
 * Custom traffic-source params t1…t20. t1–t5 are always present on a source; t6–t20 are added on demand.
 * Older data used sub1…sub5; those are read as t1…t5.
 */
export const T_MAX = 20;
export const T_BASE = 5;
export const T_KEYS = Array.from({ length: T_MAX }, (_, i) => `t${i + 1}`);
export const T_BASE_KEYS = T_KEYS.slice(0, T_BASE);

const LEGACY = { t1: 'sub1', t2: 'sub2', t3: 'sub3', t4: 'sub4', t5: 'sub5' };

/** Value of tN on a click or conversion, falling back to the legacy subN field. */
export function tValue(doc, key) {
  if (!doc) return '';
  const v = doc[key];
  if (v !== undefined && v !== null && v !== '') return String(v);
  return LEGACY[key] && doc[LEGACY[key]] ? String(doc[LEGACY[key]]) : '';
}

/** Copy the non-empty t1…t20 values of a click/conversion into a plain object. */
export function tValues(doc) {
  const out = {};
  for (const k of T_KEYS) {
    const v = tValue(doc, k);
    if (v) out[k] = v;
  }
  return out;
}

/** Rewrite legacy sub1…sub5 param mappings on a source to t1…t5 (read-time migration). */
export function normalizeSourceParams(params) {
  const src = params || {};
  const out = {};
  for (const [k, p] of Object.entries(src)) {
    const legacyOf = Object.keys(LEGACY).find((t) => LEGACY[t] === k);
    if (legacyOf) {
      if (!src[legacyOf]) out[legacyOf] = p;
    } else out[k] = p;
  }
  return out;
}

/** The t keys a source uses: t1–t5 plus any t6–t20 that have a name or token, contiguous up to the highest one. */
export function activeTKeys(params) {
  let last = T_BASE;
  T_KEYS.forEach((k, i) => {
    const p = params && params[k];
    if (p && (p.name || p.token)) last = Math.max(last, i + 1);
  });
  return T_KEYS.slice(0, last);
}
