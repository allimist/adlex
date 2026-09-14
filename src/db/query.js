/**
 * Pure query evaluation with Firestore semantics, shared by the JSON store
 * and by tests. Operates on arrays of { id, data } entries.
 */
import { DbError, INEQUALITY_OPS, OPS } from './adapter.js';

function typeRank(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'boolean') return 1;
  if (typeof v === 'number') return 2;
  if (typeof v === 'string') return 3;
  if (Array.isArray(v)) return 4;
  return 5; // objects
}

export function compareValues(a, b) {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  switch (ra) {
    case 0:
      return 0;
    case 1:
      return a === b ? 0 : a ? 1 : -1;
    case 2:
      return a === b ? 0 : a < b ? -1 : 1;
    case 3:
      return a === b ? 0 : a < b ? -1 : 1;
    case 4: {
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) {
        const c = compareValues(a[i], b[i]);
        if (c !== 0) return c;
      }
      return a.length - b.length;
    }
    default: {
      const sa = JSON.stringify(a);
      const sb = JSON.stringify(b);
      return sa === sb ? 0 : sa < sb ? -1 : 1;
    }
  }
}

function hasField(data, field) {
  return data != null && Object.prototype.hasOwnProperty.call(data, field);
}

export function matches(data, [field, op, value]) {
  if (!hasField(data, field)) return false; // Firestore: missing field never matches
  const v = data[field];
  switch (op) {
    case '==':
      return compareValues(v, value) === 0;
    case '!=':
      return compareValues(v, value) !== 0;
    case '<':
      return typeRank(v) === typeRank(value) && compareValues(v, value) < 0;
    case '<=':
      return typeRank(v) === typeRank(value) && compareValues(v, value) <= 0;
    case '>':
      return typeRank(v) === typeRank(value) && compareValues(v, value) > 0;
    case '>=':
      return typeRank(v) === typeRank(value) && compareValues(v, value) >= 0;
    case 'in':
      return Array.isArray(value) && value.some((x) => compareValues(v, x) === 0);
    case 'array-contains':
      return Array.isArray(v) && v.some((x) => compareValues(x, value) === 0);
    default:
      throw new DbError('invalid-argument', `Unknown operator ${op}`);
  }
}

/**
 * Validate a query the way Firestore would reject it at runtime.
 * spec = { filters: [[field, op, value]], orders: [[field, dir]], limit, startAfter }
 */
export function validate(spec, strict) {
  for (const f of spec.filters) {
    if (!OPS.has(f[1])) throw new DbError('invalid-argument', `Unknown operator ${f[1]}`);
    if (f[1] === 'in') {
      if (!Array.isArray(f[2])) throw new DbError('invalid-argument', "'in' requires an array");
      if (f[2].length === 0) throw new DbError('invalid-argument', "'in' requires a non-empty array");
      if (strict && f[2].length > 30) throw new DbError('invalid-argument', "'in' supports at most 30 values");
    }
  }
  if (!strict) return;
  const ineqFields = new Set(spec.filters.filter((f) => INEQUALITY_OPS.has(f[1])).map((f) => f[0]));
  if (ineqFields.size > 1) {
    throw new DbError('failed-precondition', `Inequality filters on multiple fields: ${[...ineqFields].join(', ')}`);
  }
  if (ineqFields.size === 1 && spec.orders.length > 0) {
    const [ineqField] = [...ineqFields];
    if (spec.orders[0][0] !== ineqField) {
      throw new DbError(
        'failed-precondition',
        `First orderBy must be on inequality field '${ineqField}' (got '${spec.orders[0][0]}')`,
      );
    }
  }
  if (spec.startAfter && spec.startAfter.length > spec.orders.length) {
    throw new DbError('invalid-argument', 'startAfter has more values than orderBy clauses');
  }
}

/** entries: [{ id, data }] -> filtered/sorted/paged [{ id, data }] */
export function runQuery(entries, spec, strict = false) {
  validate(spec, strict);
  let out = entries;
  for (const f of spec.filters) out = out.filter((e) => matches(e.data, f));

  if (spec.orders.length > 0) {
    // Docs missing any orderBy field are excluded (Firestore semantics).
    out = out.filter((e) => spec.orders.every(([field]) => field === '__name__' || hasField(e.data, field)));
    out = [...out].sort((x, y) => {
      for (const [field, dir] of spec.orders) {
        const a = field === '__name__' ? x.id : x.data[field];
        const b = field === '__name__' ? y.id : y.data[field];
        const c = compareValues(a, b);
        if (c !== 0) return dir === 'desc' ? -c : c;
      }
      return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
    });
  } else {
    out = [...out].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  }

  if (spec.startAfter && spec.startAfter.length > 0) {
    const cursor = spec.startAfter;
    out = out.filter((e) => {
      for (let i = 0; i < cursor.length; i++) {
        const [field, dir] = spec.orders[i];
        const v = field === '__name__' ? e.id : e.data[field];
        let c = compareValues(v, cursor[i]);
        if (dir === 'desc') c = -c;
        if (c !== 0) return c > 0;
      }
      return false; // equal to cursor -> excluded
    });
  }

  if (typeof spec.limit === 'number') out = out.slice(0, spec.limit);
  return out;
}
