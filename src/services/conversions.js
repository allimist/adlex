import { createHash } from 'node:crypto';
import { getDb } from '../db/index.js';
import { toObj, toList } from '../db/adapter.js';
import { dayUTC } from '../lib/time.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { fireForEvent } from './postbacks.js';
import { pageNewestFirst } from './clicks.js';
import { tValues } from '../lib/tparams.js';

export const REJECTED_STATUSES = new Set(['rejected', 'refund', 'chargeback', 'cancelled', 'canceled']);
/** Conversion type sent by the website (adlex-brand-click.js) when a visitor clicks an offer. */
export const BRANDCLICK_STATUS = 'brandclick';

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
/**
 * trusted: the caller already authenticated the request another way (website brand click from a
 * registered Site), so the postback token is not required.
 */
export async function recordConversion(params, { ip = '', queue = true, trusted = false } = {}) {
  const clickId = str(params.clickid, 64);
  if (!clickId) return { code: 400, text: 'ERR missing clickid' };
  const db = getDb();
  const clickSnap = await db.collection('clicks').doc(clickId).get();
  if (!clickSnap.exists) {
    // The click may still be on the event bus (Kafka lag / direct flush). Hold postbacks for fresh ids.
    if (queue && isRecentClickId(clickId)) return queuePending(params, ip, trusted);
    return { code: 404, text: 'ERR unknown clickid' };
  }
  const click = { id: clickId, ...clickSnap.data() };

  const campaign = click.campaignId ? toObj(await db.collection('campaigns').doc(click.campaignId).get()) : null;
  const source = click.sourceId ? toObj(await db.collection('sources').doc(click.sourceId).get()) : null;
  // Campaign clicks use the campaign's token; website clicks (no campaign) use the traffic source's token.
  const expectedToken = campaign ? campaign.postbackToken : source && source.postbackToken;
  if (!trusted && expectedToken && str(params.token, 64) !== expectedToken) {
    return { code: 403, text: 'ERR bad token' };
  }
  const offer = click.offerId ? toObj(await db.collection('offers').doc(click.offerId).get()) : null;

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
      ...tValues(click),
      siteId: click.siteId || '',
      domain: click.domain || '',
      pageUrl: click.pageUrl || '',
      adClickId: click.adClickId || '',
      adClickType: click.adClickType || '',
      brand: str(params.brand, 64) || click.lastBrand || '',
      ...(click.qaRun ? { qaRun: click.qaRun } : {}),
      linkType: str(params.link_type, 32),
      eventName: str(params.event_name, 100),
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

  if (status === BRANDCLICK_STATUS) {
    // A brand click is its own conversion type: it shows on the click (Brand / Outclicks columns)
    // but does not mark the click as converted or change its revenue.
    if (result === 'OK') {
      await db.collection('clicks').doc(clickId).update({
        outclicks: (Number(click.outclicks) || 0) + 1,
        lastBrand: str(params.brand, 64) || click.lastBrand || '',
        lastOutclickAt: now,
      });
    }
  } else {
    // Recompute click revenue from all its sale conversions (cheap: a click has very few).
    const all = await db.collection('conversions').where('clickId', '==', clickId).get();
    let revenue = 0;
    all.forEach((d) => {
      const c = d.data();
      if (!REJECTED_STATUSES.has(c.status) && c.status !== BRANDCLICK_STATUS) revenue += Number(c.payout) || 0;
    });
    await db.collection('clicks').doc(clickId).update({ converted: true, convertedAt: click.convertedAt || now, revenue });
  }

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

// ---- Postbacks that arrive before their click is stored ----

const PENDING_MAX_AGE_MS = 30 * 60 * 1000;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Decode the ms timestamp from a ULID; null when the id is not a ULID. */
export function ulidTime(id) {
  if (typeof id !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return null;
  let t = 0;
  for (const ch of id.slice(0, 10)) t = t * 32 + CROCKFORD.indexOf(ch);
  return t;
}

/** Our clickid, minted within the last 30 minutes (and not in the future). */
export function isRecentClickId(id, now = Date.now()) {
  const t = ulidTime(id);
  return t !== null && t <= now + 60000 && now - t <= PENDING_MAX_AGE_MS;
}

const pendingCol = () => getDb().collection('pending_conversions');
const PENDING_KEYS = ['clickid', 'payout', 'status', 'txid', 'token', 'brand', 'link_type', 'event_name'];

async function queuePending(params, ip, trusted = false) {
  const clean = {};
  for (const k of PENDING_KEYS) clean[k] = str(params[k], 128);
  const id = conversionId(clean.clickid, clean.txid).replace(/^cv_/, 'pc_');
  const now = Date.now();
  await pendingCol().doc(id).set({ params: clean, ip, trusted, state: 'pending', attempts: 0, createdAt: now, updatedAt: now });
  if (config.logClicks) logger.info({ msg: 'postback queued (click not stored yet)', clickid: clean.clickid });
  return { code: 200, text: 'QUEUED' };
}

/** Retry queued postbacks; give up (state 'orphan') once the clickid is older than 30 minutes. */
export async function retryPending(now = Date.now()) {
  const rows = toList(await pendingCol().where('state', '==', 'pending').limit(500).get());
  let done = 0;
  let orphaned = 0;
  for (const p of rows) {
    const r = await recordConversion(p.params, { ip: p.ip, queue: false, trusted: !!p.trusted });
    if (r.code === 404) {
      if (!isRecentClickId(p.params.clickid, now)) {
        await pendingCol().doc(p.id).update({ state: 'orphan', attempts: (p.attempts || 0) + 1, updatedAt: now });
        orphaned++;
      } else await pendingCol().doc(p.id).update({ attempts: (p.attempts || 0) + 1, updatedAt: now });
    } else {
      await pendingCol().doc(p.id).update({ state: r.code === 200 ? 'done' : 'failed', result: r.text, attempts: (p.attempts || 0) + 1, updatedAt: now });
      done++;
    }
  }
  return { checked: rows.length, done, orphaned };
}

export async function listOrphans() {
  return toList(await pendingCol().where('state', '==', 'orphan').limit(200).get()).sort((a, b) => b.createdAt - a.createdAt);
}

let retryTimer = null;
export function startPendingLoop(everyMs = 30000) {
  if (retryTimer) return;
  retryTimer = setInterval(() => retryPending().catch((err) => logger.error({ msg: 'pending retry failed', err: String(err) })), everyMs);
  retryTimer.unref?.();
}
export function stopPendingLoop() {
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = null;
}
