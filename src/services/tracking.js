import { getBus } from '../bus/index.js';
import { dayUTC } from '../lib/time.js';
import { ulid } from '../lib/ids.js';
import { render, buildCtx } from '../lib/macros.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { getBundleByKey } from './campaigns.js';
import { fireForEvent } from './postbacks.js';
import { T_KEYS, tValue } from '../lib/tparams.js';
import { findByHost } from './sites.js';

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

export const AD_CLICK_PARAMS = ['gclid', 'msclkid', 'fbclid', 'wbraid', 'gbraid'];

/** First ad-platform click id present in the query, e.g. { adClickId: 'Cj0K…', adClickType: 'gclid' }. */
export function adClick(query) {
  for (const k of AD_CLICK_PARAMS) {
    const v = str(query[k], 512);
    if (v) return { adClickId: v, adClickType: k };
  }
  return { adClickId: '', adClickType: '' };
}

/**
 * Add our click id and the click's t1…t20 / ad click id to a landing URL, keeping its existing params:
 *   https://site/page?x=1  ->  https://site/page?x=1&se=<clickid>&t1=…&msclkid=…
 * The website stores them as cookies and fills {se} {t1} … in its offer links.
 */
export function appendTracking(url, click, param = 'se') {
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  u.searchParams.set(param || 'se', click.id);
  for (const k of T_KEYS) {
    const v = tValue(click, k);
    if (v) u.searchParams.set(k, v);
  }
  if (click.adClickType && click.adClickId && !u.searchParams.has(click.adClickType)) {
    u.searchParams.set(click.adClickType, click.adClickId);
  }
  return u.toString();
}

/** QA page runs tag their traffic with ?adlex_qa=<runId> so results can be counted and cleaned up. */
const QA_RE = /^qa_[A-Za-z0-9]{6,40}$/;
export function qaTag(query) {
  const v = str(query.adlex_qa, 44);
  return QA_RE.test(v) ? { qaRun: v } : {};
}

/** ?lp=<url> override: only http(s) URLs on an active registered Site (never an open redirect). */
export async function landingOverride(lp) {
  const raw = str(lp, 2048);
  if (!raw) return '';
  let u;
  try {
    u = new URL(raw);
  } catch {
    return '';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  return (await findByHost(u.hostname)) ? u.toString() : '';
}

/**
 * Read mapped query params according to the source's param mapping.
 * Returns { externalId, costRaw, t: { t1: '…', … } } with only the non-empty t values.
 */
export function readMappedParams(query, source) {
  const params = (source && source.params) || {};
  const get = (key) => {
    const name = params[key] && params[key].name ? params[key].name : key;
    return str(query[name], 255);
  };
  const t = {};
  for (const k of T_KEYS) {
    const v = get(k);
    if (v) t[k] = v;
  }
  return { externalId: get('clickid'), costRaw: get('cost'), t };
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
    ...mapped.t,
    ...adClick(req.query),
    ...qaTag(req.query),
    ip: req.ip || '',
    ua: str(req.get('user-agent'), 512),
    referer: str(req.get('referer'), 1024),
    country: str(req.get('cloudfront-viewer-country') || req.get('x-country'), 2).toUpperCase(),
    converted: false,
    convertedAt: null,
    revenue: 0,
  };

  const ctx = buildCtx({ click, campaign, offer, source });
  let target = (campaign.allowLp && (await landingOverride(req.query.lp))) || render(offer.url, ctx, 'url');
  if (offer.appendTracking) target = appendTracking(target, click, offer.trackingParam);
  res.redirect(302, target);

  const { id, ...data } = click;
  getBus().publish({ type: 'click', id, clickId: id, data });
  if (config.logClicks) logger.info({ msg: 'click', clickid: id, campaign: campaign.key, offer: offer.id, ext: click.externalId, ip: click.ip });
  fireForEvent('click', { click, campaign, offer, source, conversion: null }).catch((err) =>
    logger.error({ msg: 'click trigger failed', err: String(err) }),
  );
}

/** Minimal bot check for flagging (not blocking) website sessions. */
const BOT_RE = /bot|crawl|spider|slurp|headless|lighthouse|pingdom|monitor|curl|wget|python-requests|httpclient|facebookexternalhit|preview/i;
export function isBot(ua) {
  return !ua || BOT_RE.test(ua);
}

export { str };
