/**
 * Firestore-shaped adapter contract. Every driver (jsonStore, firestoreStore)
 * must expose exactly this surface. Application code imports getDb() from
 * ./index.js and never touches storage directly.
 *
 * db.collection(name) -> CollectionRef
 * db.batch()          -> WriteBatch
 * db.close()          -> Promise<void>
 *
 * CollectionRef / Query (immutable builders):
 *   .doc(id?)                       -> DocRef        (CollectionRef only)
 *   .add(data)                      -> Promise<DocRef> (CollectionRef only)
 *   .where(field, op, value)        -> Query   op: == != < <= > >= in array-contains
 *   .orderBy(field, dir='asc')      -> Query
 *   .limit(n)                       -> Query
 *   .startAfter(...values)          -> Query   one value per orderBy clause
 *   .get()                          -> Promise<QuerySnapshot>
 *
 * DocRef: .id, .get(), .set(data, {merge}), .create(data), .update(partial), .delete()
 * DocSnapshot: { id, exists, data() }
 * QuerySnapshot: { docs, size, empty, forEach(fn) }
 * WriteBatch: .set(ref, data, opts) .update(ref, partial) .delete(ref) -> this ; .commit()
 */

export class DbError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'DbError';
    this.code = code; // 'not-found' | 'already-exists' | 'invalid-argument' | 'failed-precondition'
  }
}

/** Spread a snapshot into a plain object with its id. */
export function toObj(snap) {
  if (!snap || !snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

/** Map a QuerySnapshot to plain objects. */
export function toList(qs) {
  return qs.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export const OPS = new Set(['==', '!=', '<', '<=', '>', '>=', 'in', 'array-contains']);
export const INEQUALITY_OPS = new Set(['<', '<=', '>', '>=', '!=']);
