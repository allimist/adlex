import { createHash } from 'node:crypto';
import { getDb } from '../db/index.js';
import { toObj } from '../db/adapter.js';
import { dayUTC } from '../lib/time.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { fireForEvent } from './postbacks.js';
import { pageNewestFirst } from './clicks.js';

export const REJECTED_STATUSES = new Set(['rejected', 'refund', 'chargeback', 'cancelled', 'canceled']);

export function conversionId(clickId, txid) {
  if (txid) return 'cv_' + createHash('sha1').update(`${clickId}:${txid}`).digest('hex').slice(0, 24);
  return 'cv_' + clickId;
}

function str(v, max) {
  if (Array.isArray(v)) v = v[0];
  return v === undefined || v === null ? '' : String(v).slice(0, max);
}

/**
 * Record a conversion for an incoming postback.
 * Returns { code, text, conversion?, click? } where text is the HTTP body to answer with.
 */
export async function recordConversion(params, { ip = '' } = {}) {
  const clickId = str(params.clickid, 64);
  if (!clickId) return { code: 400, text: 'ERR missing clickid' };
  const db = getDb();
  const clickSnap = await db.collection('clicks').doc(clickId).get();
  if (!clickSnap.exists) return { code: 404, text: 'ERR unknown clickid' };
  const click = { id: clickId, ...clickSnap.data() };

  const campaign = toObj(await db.collection('campaigns').doc(click.campaignId).get());
  if (campaign && campaign.postbackToken && str(params.token, 64) !== campaign.postbackToken) {
    return { code: 403, text: 'ERR bad token' };
  }
  const offer = click.offerId ? toObj(await db.collection('offers').doc(click.offerId).get()) : null;
  const source = toObj(await db.collection('sources').doc(click.sourceId).get());

  const payoutRaw = parseFloat(str(params.payout, 32));
  const payout = Number.isFinite(payoutRaw) && payoutRaw >= 0 ? payoutRaw : Number((offer && offer.payout) || 0);
  const status = (str(params.status, 32) || 'lead').toLowerCase();
  const txid = str(params.txid, 128);
  const now = Date.now();
  const id = conversionId(clickId, txid);
  const ref = db.collection('conversions').doc(id);

  const existing = await ref.get();
  let result;
  if (existing.exists) {
    if (txid) return { code: 200, text: 'DUPLICATE' };
    await ref.update({ status, payout, updatedAt: now, ip });
    result = 'UPDATED';
  } else {
    const doc = {
      createdAt: now,
      day: dayUTC(now),
      clickId,
      clickCreatedAt: click.createdAt,
      clickDay: click.day,
      campaignId: click.campaignId,
      sourceId: click.sourceId,
      offerId: click.offerId,
      externalId: click.externalId || '',
      txid,
      status,
      payout,
      sub1: click.sub1 || '',
      sub2: click.sub2 || '',
      sub3: click.sub3 || '',
      sub4: click.sub4 || '',
      sub5: click.sub5 || '',
      ip,
      updatedAt: now,
    };
    try {
      await ref.create(doc);
    } catch (err) {
      if (err.code === 'already-exists') return { code: 200, text: 'DUPLICATE' };
      throw err;
    }
    result = 'OK';
  }

  // Recompute click revenue from all its conversions (cheap: a click has very few).
  const all = await db.collection('conversions').where('clickId', '==', clickId).get();
  let revenue = 0;
  all.forEach((d) => {
    const c = d.data();
    if (!REJECTED_STATUSES.has(c.status)) revenue += Number(c.payout) || 0;
  });
  await db.collection('clicks').doc(clickId).update({ converted: true, convertedAt: click.convertedAt || now, revenue });

  const conversion = { id, ...(await ref.get()).data() };
  if (config.logClicks) logger.info({ msg: 'postback', clickid: clickId, result, status, payout, txid });
  fireForEvent('conversion', { click, campaign: campaign || {}, offer: offer || {}, source: source || {}, conversion }).catch((err) =>
    logger.error({ msg: 'trigger firing failed', err: String(err) }),
  );
  return { code: 200, text: result, conversion, click };
}

export async function listConversions({ campaignId, offerId, from, to, after }) {
  return pageNewestFirst('conversions', { equals: { campaignId, offerId }, from, to, after });
}
