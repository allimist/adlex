/**
 * Website collector, compatible with the bestoffers CMS scripts (formerly db.bestoffers.biz):
 *   GET /se/?<landing params>&page_url=…   -> starts a session click, answers the clickid as text (stored as the `se` cookie)
 *   GET /pc/?event_type=brandclick&event_id=<clickid>&brand=…&link_type=…   -> records an offer ("brand") click
 * Both answer immediately; persistence happens through the event bus.
 */
import { dayUTC } from '../lib/time.js';
import { ulid } from '../lib/ids.js';
import { logger } from '../lib/logger.js';
import { TtlCache } from '../lib/cache.js';
import { RateLimiter } from '../lib/ratelimit.js';
import { normalizeSourceParams } from '../lib/tparams.js';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { toObj } from '../db/adapter.js';
import { getBus } from '../bus/index.js';
import { getBundleByKey } from './campaigns.js';
import { findByHost, requestHost, normalizeDomain } from './sites.js';
import { readMappedParams, computeCost, isBot, str, adClick, qaTag, AD_CLICK_PARAMS } from './tracking.js';
export { adClick, AD_CLICK_PARAMS };
import { fireForEvent } from './postbacks.js';
import { recordConversion, BRANDCLICK_STATUS } from './conversions.js';

const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const limiter = new RateLimiter({ limit: config.collectRatePerMin, windowMs: 60000 });
const sourceCache = new TtlCache(30000);

async function getSource(id) {
  const hit = sourceCache.get(id);
  if (hit !== undefined) return hit;
  const s = toObj(await getDb().collection('sources').doc(id).get());
  if (s) s.params = normalizeSourceParams(s.params);
  return sourceCache.set(id, s);
}

function cors(req, res) {
  const origin = req.get('origin');
  if (origin && origin !== 'null') {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Credentials', 'true');
  }
  res.set('Vary', 'Origin');
  res.set('Cache-Control', 'no-store');
}

/**
 * Requests from this machine itself (QA test browsers, local testing) are not rate limited.
 * Only when there is no X-Forwarded-For: traffic through a proxy on the same host is still limited.
 */
export function isLocalDirect(req) {
  const ip = req.socket && req.socket.remoteAddress;
  return (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') && !req.get('x-forwarded-for');
}

/** Common gate: rate limit + known site. Returns the site, or null after answering the request. */
async function gate(req, res) {
  if (!isLocalDirect(req) && !limiter.allow(req.ip || '')) {
    res.status(429).type('text').send('ERR rate limited');
    return null;
  }
  const host = requestHost(req);
  const site = host ? await findByHost(host) : null;
  if (!site) {
    res.status(403).type('text').send('ERR unknown site');
    return null;
  }
  cors(req, res);
  return { site, host: normalizeDomain(host) };
}

export function preflight(req, res) {
  cors(req, res);
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Max-Age', '86400');
  res.status(204).end();
}

/**
 * ?click=<campaign key> on the landing (forwarded to /se/ by the site's session.js): the visit belongs
 * to that adlex campaign — e.g. a Bing ad whose final URL ends with &click=fteyh7mf.
 * Unknown or archived keys are ignored and the click stays a plain site click.
 */
async function campaignFromQuery(query) {
  const key = str(query.click, 32);
  if (!/^[a-z0-9]{4,32}$/.test(key)) return null;
  const bundle = await getBundleByKey(key);
  return bundle && bundle.campaign.status !== 'archived' ? bundle : null;
}

/** The campaign offer this landing is: its only active offer, else the one on the same host. */
function landingOffer(bundle, host) {
  const active = bundle.offers.filter((o) => o.status === 'active');
  if (active.length === 1) return active[0];
  return (
    active.find((o) => {
      try {
        return new URL(o.url).hostname.replace(/^www\./, '') === host;
      } catch {
        return false;
      }
    }) || null
  );
}

export async function handleSession(req, res) {
  const g = await gate(req, res);
  if (!g) return;
  const { site, host } = g;
  const bundle = await campaignFromQuery(req.query);
  const campaign = bundle ? bundle.campaign : null;
  const offer = bundle ? landingOffer(bundle, host) : null;
  // A campaign's traffic source decides the param mapping and cost; otherwise the site's source
  const source = (bundle && bundle.source) || (await getSource(site.sourceId));
  const mapped = readMappedParams(req.query, source);
  const now = Date.now();
  const ua = str(req.get('user-agent'), 512);
  const click = {
    id: ulid(now),
    day: dayUTC(now),
    createdAt: now,
    campaignId: campaign ? campaign.id : '',
    campaignKey: campaign ? campaign.key : '',
    sourceId: campaign ? campaign.sourceId : site.sourceId,
    offerId: offer ? offer.id : '',
    siteId: site.id,
    domain: host,
    pageUrl: str(req.query.page_url, 512),
    externalId: mapped.externalId,
    cost: computeCost(source, campaign || { costPerClick: 0 }, mapped.costRaw),
    ...mapped.t,
    ...adClick(req.query),
    ...qaTag(req.query),
    ip: req.ip || '',
    ua,
    referer: str(req.get('referer'), 1024),
    country: str(req.get('cloudfront-viewer-country') || req.get('x-country'), 2).toUpperCase(),
    bot: isBot(ua),
    converted: false,
    convertedAt: null,
    revenue: 0,
    outclicks: 0,
    lastBrand: '',
    lastOutclickAt: 0,
  };
  res.status(200).type('text').send(click.id);

  const { id, ...data } = click;
  getBus().publish({ type: 'click', id, clickId: id, data });
  if (config.logClicks) logger.info({ msg: 'session', clickid: id, site: site.id, campaign: click.campaignKey, ad: click.adClickType, ip: click.ip });
  fireForEvent('click', { click, campaign: campaign || {}, offer: offer || {}, source: source || {}, conversion: null }).catch((err) =>
    logger.error({ msg: 'click trigger failed', err: String(err) }),
  );
}

/**
 * /pc/ — the db.bestoffers.biz event endpoint, kept compatible:
 *  - brand click from the site's brand-click.js:
 *      /pc/?record_source=site&event_type=brandclick&brand=…&link_type=…&event_id=<se>
 *    -> `brandclick` conversion (registered Site required, no token), same as the adlex-mode flow;
 *  - anything else is an affiliate-network postback (legacy defaults record_source=postback,
 *    event_type=converssion): /pc/?event_id=<se>&revenue=…&brand=…&event_name=…
 *    -> sale conversion; the traffic source's postback token applies when one is set.
 */
export async function handleLegacyEvent(req, res) {
  const q = req.query;
  const eventType = str(q.event_type, 32).toLowerCase();
  if (str(q.record_source, 20).toLowerCase() === 'site' || eventType === BRANDCLICK_STATUS) {
    return handleBrandConversion(req, res, { clickid: q.event_id, brand: q.brand, link_type: q.link_type });
  }
  const clickid = str(q.event_id, 64);
  if (!EVENT_ID_RE.test(clickid)) return res.status(400).type('text').send('ERR bad event_id');
  // The PHP tracker stored event_type as-is; its default (misspelled) "converssion" means a sale.
  const status = str(q.status, 32) || (eventType && !['converssion', 'conversion'].includes(eventType) ? eventType : 'sale');
  const result = await recordConversion(
    {
      clickid,
      payout: q.revenue !== undefined ? q.revenue : q.payout,
      status,
      txid: str(q.txid, 128),
      brand: q.brand,
      event_name: q.event_name,
      token: q.token,
    },
    { ip: req.ip || '' },
  );
  res.status(result.code).set('Cache-Control', 'no-store').type('text').send(result.text);
}

/**
 * Brand click from adlex-brand-click.js: /postback?clickid=<se>&status=brandclick&brand=…&link_type=…
 * Sent from the browser, so it cannot carry the postback token; instead it must come from a
 * registered Site (Origin/Referer). Always payout 0, one conversion per click and brand.
 */
export async function handleBrandConversion(req, res, params) {
  const g = await gate(req, res);
  if (!g) return;
  const brand = str(params.brand, 64);
  const result = await recordConversion(
    {
      clickid: str(params.clickid, 64),
      status: BRANDCLICK_STATUS,
      payout: '0',
      txid: `${BRANDCLICK_STATUS}:${brand}`,
      brand,
      link_type: str(params.link_type, 32),
    },
    { ip: req.ip || '', trusted: true },
  );
  res.status(result.code).type('text').send(result.text);
}
