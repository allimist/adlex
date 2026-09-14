import { getDb } from '../db/index.js';
import { toList, toObj } from '../db/adapter.js';

const col = () => getDb().collection('clicks');
export const PAGE_SIZE = 50;

export async function getById(id) {
  return toObj(await col().doc(id).get());
}

/** Encode/decode "createdAt_id" cursors for newest-first pagination. */
export function encodeCursor(row) {
  return row ? `${row.createdAt}_${row.id}` : null;
}
export function decodeCursor(s) {
  if (!s || typeof s !== 'string') return null;
  const i = s.indexOf('_');
  if (i < 0) return null;
  const t = Number(s.slice(0, i));
  return Number.isFinite(t) ? [t, s.slice(i + 1)] : null;
}

/**
 * Generic newest-first page over a collection with equality filters + createdAt range.
 * Query shape is Firestore-valid: equalities, one inequality field (createdAt), orderBy createdAt desc, id.
 */
export async function pageNewestFirst(collection, { equals = {}, from, to, after, limit = PAGE_SIZE }) {
  let q = getDb().collection(collection);
  for (const [k, v] of Object.entries(equals)) if (v !== undefined && v !== '' && v !== null) q = q.where(k, '==', v);
  if (from) q = q.where('createdAt', '>=', from);
  if (to) q = q.where('createdAt', '<', to);
  q = q.orderBy('createdAt', 'desc').orderBy('__name__', 'asc');
  const cursor = decodeCursor(after);
  if (cursor) q = q.startAfter(...cursor);
  const rows = toList(await q.limit(limit + 1).get());
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { rows: page, nextAfter: hasMore ? encodeCursor(page[page.length - 1]) : null };
}

export async function listClicks({ campaignId, converted, from, to, after }) {
  const equals = { campaignId };
  if (converted === '1') equals.converted = true;
  if (converted === '0') equals.converted = false;
  return pageNewestFirst('clicks', { equals, from, to, after });
}
