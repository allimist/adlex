import { getDb } from '../db/index.js';
import { dayUTC } from '../lib/time.js';
import { ulid } from '../lib/ids.js';
import { render, buildCtx } from '../lib/macros.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { getBundleByKey } from './campaigns.js';
import { fireForEvent } from './postbacks.js';

/** Weighted random pick among active offers with weight > 0. Returns null when none. */
export function pickOffer(offers, rand = Math.random) {
  const eligible = offers.filter((o) => o.status === 'active' && o.weight > 0);
  if (eligible.length === 0) return null;
  const total = eligible.reduce((s, o) => s + o.weight, 0);
  let r = rand() * total;
  for (const o of eligible) {
    r -= o.weight;
    if (r < 0) return o;
  }
  return eligible[eligible.length - 1];
}

function str(v, max) {
  if (Array.isArray(v)) v = v[0];
  if (v === undefined || v === null) return '';
  return String(v).slice(0, max);
}

/** Read mapped query params according to the source's param mapping. */
export function readMappedParams(query, source) {
  const params = (source && source.params) || {};
  const get = (key) => {
    const name = params[key] && params[key].name ? params[key].name : key;
    return str(query[name], 255);
  };
  return {
    externalId: get('clickid'),
    costRaw: get('cost'),
    sub1: get('sub1'),
    sub2: get('sub2'),
    sub3: get('sub3'),
    sub4: get('sub4'),
    sub5: get('sub5'),
  };
}

export function computeCost(source, campaign, costRaw) {
  const model = source ? source.costModel : 'cpc';
  if (model === 'none') return 0;
  if (model === 'param') {
    const n = parseFloat(costRaw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return Number(campaign.costPerClick) || 0;
}

/**
 * Express handler for GET /click/:campaignKey. Redirects first, persists after.
 */
export async function handleClick(req, res) {
  res.set('Cache-Control', 'no-store');
  const bundle = await getBundleByKey(req.params.campaignKey);
  if (!bundle || bundle.campaign.status === 'archived') return res.status(404).type('text').send('Unknown campaign');
  const { campaign, source, offers } = bundle;

  if (campaign.status !== 'active') {
    if (campaign.fallbackUrl) return res.redirect(302, campaign.fallbackUrl);
    return res.status(404).type('text').send('Campaign paused');
  }

  const offer = pickOffer(offers);
  if (!offer) {
    if (campaign.fallbackUrl) return res.redirect(302, campaign.fallbackUrl);
    return res.status(404).type('text').send('No active offer');
  }

  const mapped = readMappedParams(req.query, source);
  const now = Date.now();
  const click = {
    id: ulid(now),
    day: dayUTC(now),
    createdAt: now,
    campaignId: campaign.id,
    campaignKey: campaign.key,
    sourceId: campaign.sourceId,
    offerId: offer.id,
    externalId: mapped.externalId,
    cost: computeCost(source, campaign, mapped.costRaw),
    sub1: mapped.sub1,
    sub2: mapped.sub2,
    sub3: mapped.sub3,
    sub4: mapped.sub4,
    sub5: mapped.sub5,
    ip: req.ip || '',
    ua: str(req.get('user-agent'), 512),
    referer: str(req.get('referer'), 1024),
    country: str(req.get('cloudfront-viewer-country') || req.get('x-country'), 2).toUpperCase(),
    converted: false,
    convertedAt: null,
    revenue: 0,
  };

  const ctx = buildCtx({ click, campaign, offer, source });
  const target = render(offer.url, ctx, 'url');
  res.redirect(302, target);

  const { id, ...data } = click;
  getDb()
    .collection('clicks')
    .doc(id)
    .set(data)
    .then(() => {
      if (config.logClicks) logger.info({ msg: 'click', clickid: id, campaign: campaign.key, offer: offer.id, ext: click.externalId, ip: click.ip });
      return fireForEvent('click', { click, campaign, offer, source, conversion: null });
    })
    .catch((err) => logger.error({ msg: 'click write failed', err: String(err) }));
}
