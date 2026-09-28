/**
 * Persist tracking events that arrive through the event bus (direct buffer or Kafka).
 * Idempotent: a redelivered click or outclick is skipped, so Kafka at-least-once delivery is safe.
 *
 * Event shapes:
 *   { type: 'click',    id, data }                      data = full click document
 *   { type: 'outclick', id, clickId, brand, linkType, createdAt, ... }
 */
import { getDb } from '../db/index.js';
import { logger } from '../lib/logger.js';

const MAX_BATCH_OPS = 400; // Firestore allows 500 writes per batch

async function existing(collection, ids) {
  const db = getDb();
  const snaps = await Promise.all([...new Set(ids)].map((id) => db.collection(collection).doc(id).get()));
  const out = new Map();
  for (const s of snaps) if (s.exists) out.set(s.id, s.data());
  return out;
}

export async function applyEvents(events) {
  if (!events || events.length === 0) return { clicks: 0, outclicks: 0, skipped: 0 };
  const db = getDb();
  const clickEvents = events.filter((e) => e && e.type === 'click' && e.id && e.data);
  const outEvents = events.filter((e) => e && e.type === 'outclick' && e.id && e.clickId);

  const [clicksInDb, outclicksInDb, outTargets] = await Promise.all([
    existing('clicks', clickEvents.map((e) => e.id)),
    existing('outclicks', outEvents.map((e) => e.id)),
    existing('clicks', outEvents.map((e) => e.clickId)),
  ]);

  // New clicks are built in memory first so outclicks in the same batch can update them before the write.
  const newClicks = new Map();
  for (const e of clickEvents) if (!clicksInDb.has(e.id) && !newClicks.has(e.id)) newClicks.set(e.id, { ...e.data });

  const clickUpdates = new Map();
  const outDocs = [];
  const seenOut = new Set();
  for (const e of outEvents) {
    if (outclicksInDb.has(e.id) || seenOut.has(e.id)) continue;
    seenOut.add(e.id);
    const { type, id, ...doc } = e;
    outDocs.push([id, doc]);
    const patch = (target) => {
      target.outclicks = (Number(target.outclicks) || 0) + 1;
      if (!target.lastOutclickAt || doc.createdAt >= target.lastOutclickAt) {
        target.lastBrand = doc.brand || '';
        target.lastOutclickAt = doc.createdAt;
      }
    };
    if (newClicks.has(e.clickId)) patch(newClicks.get(e.clickId));
    else if (outTargets.has(e.clickId)) {
      const cur = clickUpdates.get(e.clickId) || { ...pick(outTargets.get(e.clickId)) };
      patch(cur);
      clickUpdates.set(e.clickId, cur);
    }
    // else: brand click for a click we never saw (expired cookie, other tracker) — kept in outclicks only.
  }

  const ops = [];
  for (const [id, data] of newClicks) ops.push(['set', db.collection('clicks').doc(id), data]);
  for (const [id, data] of outDocs) ops.push(['set', db.collection('outclicks').doc(id), data]);
  for (const [id, data] of clickUpdates) ops.push(['update', db.collection('clicks').doc(id), data]);

  for (let i = 0; i < ops.length; i += MAX_BATCH_OPS) {
    const batch = db.batch();
    for (const [op, ref, data] of ops.slice(i, i + MAX_BATCH_OPS)) batch[op](ref, data);
    await batch.commit();
  }

  const skipped = events.length - newClicks.size - outDocs.length;
  if (skipped > 0) logger.info({ msg: 'ingest skipped duplicates/invalid', skipped });
  return { clicks: newClicks.size, outclicks: outDocs.length, skipped };
}

function pick(click) {
  return { outclicks: click.outclicks || 0, lastBrand: click.lastBrand || '', lastOutclickAt: click.lastOutclickAt || 0 };
}
