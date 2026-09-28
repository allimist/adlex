/**
 * Placeholder for the Firebase/Firestore driver. When swapping:
 *   npm i @google-cloud/firestore  (or firebase-admin)
 *   const { Firestore } = await import('@google-cloud/firestore');
 *   return new Firestore(); // already exposes collection/doc/where/orderBy/limit/startAfter/batch
 * The native SDK matches the adapter surface in ./adapter.js one-to-one, so only
 * this factory and the composite indexes below are needed.
 *
 * Composite indexes required by the app's queries:
 *   clicks        (campaignId asc, createdAt desc)
 *   clicks        (converted asc, createdAt desc)
 *   clicks        (campaignId asc, converted asc, createdAt desc)
 *   conversions   (campaignId asc, createdAt desc)
 *   conversions   (offerId asc, createdAt desc)
 *   conversions   (campaignId asc, offerId asc, createdAt desc)
 *   postback_logs (triggerId asc, createdAt desc)
 *   postback_logs (clickId asc, createdAt desc)
 *   clicks        (siteId asc, createdAt desc)
 *   clicks        (siteId asc, converted asc, createdAt desc)
 *   export_logs   (exportId asc, createdAt desc)
 *   exports       single-field index on token (default)
 *   pending_conversions single-field index on state (default)
 *   sessions      TTL policy on expiresAt
 *
 * Scaling note: reports currently scan clicks/conversions in a date range. Past
 * ~1M clicks, add a stats_daily collection keyed `${day}_${campaignId}` updated
 * with FieldValue.increment at click/postback time and sum those instead.
 */
export async function createFirestoreStore() {
  throw new Error('DB_DRIVER=firestore is not configured yet. See src/db/firestoreStore.js');
}
